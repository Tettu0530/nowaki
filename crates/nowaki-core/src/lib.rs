//! The engine of the [`nowaki`](https://crates.io/crates/nowaki) CLI: the oxc-based transform
//! pipeline, resolver, bundler and module cache that `nowaki dev`, `nowaki build` and
//! `nowaki prerender` run.
//!
//! **This crate is internal.** It is published so that `cargo install nowaki` works, and it is
//! not a supported API for other programs. It has its own 0.x version line, independent of
//! Nowaki's (a minor may break it, as 0.x allows), and `nowaki` depends on it with an exact `=`
//! requirement. Use the `nowaki` CLI instead. See [docs/STABILITY.md](https://github.com/Tettu0530/nowaki/blob/main/docs/STABILITY.md).

pub mod asset;
pub mod budget;
pub mod build;
pub mod cache;
pub mod chunk;
pub mod compress;
pub mod css;
pub mod env;
pub mod graph;
pub mod highlight;
pub mod image;
pub mod live_hint;
pub mod mdx;
pub mod page_scripts;
pub mod public;
pub mod remote_image;
pub mod resolve;
pub mod route_css;
pub mod routes;
pub mod rules;
pub mod server_fn;
pub mod transform;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use oxc_resolver::Resolver;
use xxhash_rust::xxh3::xxh3_64;

pub use cache::Mode;
pub use remote_image::{RemoteFetch, RemoteImages, RemotePattern};

/// Synthetic directory name for plugin virtual modules (it never exists on disk).
/// A virtual id returned by `resolveId` maps to `<root>/__nowaki_virtual__/<hash>.js`;
/// [`NowakiCore::read_source`] looks the original id up and gets the source from the `load`
/// hook.
pub const VIRTUAL_DIR: &str = "__nowaki_virtual__";

/// Bridge for calling plugin hooks from Rust. The CLI implements it by delegating over HTTP to
/// the Node plugin host (which loads `nowaki.config`). nowaki-core itself runs no JavaScript;
/// this trait is its only way to reach plugins.
///
/// `transform` / `compile_tsrx` / `load` return `Err` when the hook could not run (the host is
/// down, a plugin threw, the compiler reported errors). `Ok(None)` means "no change", so a failure
/// must never be reported as `None`: that would serve the untransformed source as if it were fine.
pub trait PluginBridge: Send + Sync {
    /// The `transform(code, id)` hook for transformable sources (ts/tsx/js/jsx/mjs).
    /// `Ok(None)` if no plugin changed it.
    fn transform(&self, id: &str, code: &str) -> Result<Option<String>>;

    /// Compiles `.tsrx` source to standard JSX with `@tsrx/preact`. The output then goes
    /// through oxc's JSX→preact pipeline. `Ok(None)` if the compiler isn't installed.
    fn compile_tsrx(&self, id: &str, code: &str) -> Result<Option<String>>;

    /// `resolveId(source, importer)` for virtual modules. If a plugin claims the specifier, returns
    /// the resolved id (a real path or a virtual id string); None if no plugin claims it.
    /// Called only when normal resolution fails, so it never sees specifiers that resolve on disk.
    fn resolve_id(&self, _source: &str, _importer: &str) -> Option<String> {
        None
    }

    /// `load(id)` for virtual modules: the source for a virtual id from `resolveId`.
    /// `Ok(None)` if no plugin loads it.
    fn load(&self, _id: &str) -> Result<Option<String>> {
        Ok(None)
    }
}

/// Whether `path` has an extension Nowaki transforms into a JS module. Anything else (CSS,
/// images, etc.) is served as is.
/// `.tsrx` is compiled to JSX by `@tsrx/preact` in the plugin host, then run through oxc.
/// `.mdoc` (Markdoc) has no built-in compiler: a plugin (`@nowaki-dev/markdoc`) must turn it into
/// a module.
pub fn is_transformable(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("ts" | "tsx" | "js" | "jsx" | "mjs" | "tsrx" | "mdx" | "mdoc")
    )
}

/// The error for a `.mdoc` file no plugin compiled.
fn no_markdoc_plugin(abs: &Path) -> anyhow::Error {
    anyhow::anyhow!(
        "{}: no plugin compiled this Markdoc file; add @nowaki-dev/markdoc to plugins in nowaki.config.mjs",
        abs.display()
    )
}

/// Whether `path` is an asset that imports as its URL string (images, fonts, media, PDF), case
/// insensitively: in `import logo from "./logo.png"`, `logo` is the served URL.
pub fn is_asset(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some(
            "png"
                | "jpg"
                | "jpeg"
                | "gif"
                | "svg"
                | "webp"
                | "avif"
                | "ico"
                | "bmp"
                | "woff"
                | "woff2"
                | "ttf"
                | "otf"
                | "eot"
                | "mp4"
                | "webm"
                | "ogg"
                | "mp3"
                | "wav"
                | "flac"
                | "pdf"
        )
    )
}

/// The bundler core for one app: resolver, module caches, and settings. `nowaki dev` serves
/// modules from it, and `nowaki build` builds with it.
pub struct NowakiCore {
    /// The app root, canonicalized when it exists (see [`NowakiCore::new`]).
    pub root: PathBuf,
    resolver: Resolver,
    cache: cache::ModuleCache,
    /// The files each cached module inlines (see `remember`).
    inputs: cache::InputsCache,
    /// Persistent cache that survives restarts.
    disk_cache: cache::DiskCache,
    /// Client constant-replacement pairs for `import.meta.env` (`PUBLIC_*` from `.env` or
    /// `env.ts`, `MODE`, `BASE_URL`, ...).
    pub(crate) client_defines: Vec<(String, String)>,
    /// Plugin transform hooks (optional). If unset, files are read as is.
    plugins: Option<Arc<dyn PluginBridge>>,
    /// Hash of what the plugins' output depends on besides the file itself (nowaki.config's text,
    /// whether a `.tsrx` compiler is present). Mixed into every cache key, so a cache hit never
    /// needs to ask the plugin host.
    plugin_salt: u64,
    /// `read_source` results by file: (hash of the file's own text + plugin_salt, the source after
    /// MDX and plugins). The graph, chunking, budgets, and the transform all read the same modules
    /// several times per build; plugins run once per version of a file.
    source_cache: dashmap::DashMap<PathBuf, (u64, String)>,
    /// Virtual module synthetic path → original id (as returned by `resolveId`), for `load`.
    virtual_ids: Mutex<HashMap<PathBuf, String>>,
    /// Remote `?image` imports (`images.remotePatterns`); None refuses every remote image.
    remote: Option<Arc<RemoteImages>>,
    /// Hash of the remote patterns, in every cache key (MDX output depends on them).
    remote_salt: u64,
    /// nowaki.config `basePath` ("" at the root); see `set_base_path`.
    base_path: String,
    /// `nowaki dev` Fast Refresh for browser modules (`set_dev_refresh`); off for builds.
    dev_refresh: bool,
    /// Hot module versions by file (`bump_dev_version`). Empty outside `nowaki dev`.
    dev_versions: dashmap::DashMap<PathBuf, u64>,
    /// Source of the version numbers: one counter, so a number is never reused for a file.
    dev_version_seq: std::sync::atomic::AtomicU64,
}

impl NowakiCore {
    /// A core for the app at `root`, with the client defines from its `.env` files and no
    /// plugins, base path, or remote images.
    pub fn new(root: PathBuf) -> Self {
        // Resolved module paths are canonical, so the root must be too, or `root.starts_with`
        // checks (which modules are the app's, and get hoisted) miss through a symlinked path
        // (macOS /var → /private/var) or a Windows verbatim `\\?\C:\…` one. dunce keeps Windows
        // paths in their normal form. A root that doesn't exist yet is kept as given.
        let root = dunce::canonicalize(&root).unwrap_or(root);
        let client_defines = env::load_client_defines(&root);
        let disk_cache = cache::DiskCache::new(&root, defines_salt(&client_defines));
        highlight::set_cache_root(&root);
        Self {
            root,
            resolver: resolve::make_resolver(),
            cache: cache::ModuleCache::default(),
            inputs: cache::InputsCache::default(),
            disk_cache,
            client_defines,
            plugins: None,
            plugin_salt: 0,
            source_cache: dashmap::DashMap::new(),
            virtual_ids: Mutex::new(HashMap::new()),
            remote: None,
            remote_salt: 0,
            base_path: String::new(),
            dev_refresh: false,
            dev_versions: dashmap::DashMap::new(),
            dev_version_seq: std::sync::atomic::AtomicU64::new(0),
        }
    }

    /// `nowaki dev` only: browser modules of the app (not its dependencies) get oxc's Fast
    /// Refresh transform, registering their components with `client/refresh.js`
    /// ([`transform::REFRESH_RUNTIME_URL`]), which they import. SSR and builds never do. Resets the
    /// in-memory transform cache.
    pub fn set_dev_refresh(&mut self, on: bool) {
        if self.dev_refresh != on {
            self.dev_refresh = on;
            self.cache.clear();
            self.inputs.clear();
        }
    }

    /// Whether [`Self::set_dev_refresh`] turned Fast Refresh on.
    pub fn dev_refresh(&self) -> bool {
        self.dev_refresh
    }

    /// `nowaki dev` hot updates: gives the app module `abs` a new version and returns it. Browser
    /// imports of `abs` then carry `?t=<version>`, so the browser loads it again; modules whose
    /// version never changed keep their URL (one instance). Bump every importer of `abs` up to the
    /// module the browser re-imports, or an importer keeps the old URL in its cached output.
    pub fn bump_dev_version(&self, abs: &Path) -> u64 {
        let n = self
            .dev_version_seq
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            + 1;
        self.dev_versions.insert(abs.to_path_buf(), n);
        n
    }

    /// The hot module version of `abs` (see [`Self::bump_dev_version`]); None if never bumped.
    pub fn dev_version(&self, abs: &Path) -> Option<u64> {
        self.dev_versions.get(abs).map(|n| *n)
    }

    /// The dev browser URL of an app file (`/islands/Counter.tsx`, `/@fs/…` outside the root),
    /// with `?t=<version>` once [`Self::bump_dev_version`] gave it one.
    pub fn dev_module_url(&self, abs: &Path) -> String {
        let url = resolve::fs_path_to_url(&self.root, abs);
        match self.dev_version(abs) {
            Some(n) => transform::with_version(&url, n),
            None => url,
        }
    }

    /// Serves the app under `base` (nowaki.config `basePath`, like `/app`; `""` for the root):
    /// emitted asset URLs become `<base>/_nowaki/<file>`, server function proxies post to
    /// `<base>/__nowaki/fn`, and `import.meta.env.BASE_URL` is `<base>/`. A base that isn't a
    /// plain path (no trailing slash) is an error and changes nothing. Call it before building or
    /// serving modules: it resets the transform caches.
    pub fn set_base_path(&mut self, base: &str) -> Result<()> {
        rules::check_base_path(base).map_err(|e| anyhow::anyhow!(e))?;
        let mut defines = self.client_defines.clone();
        env::set_base_url(&mut defines, base);
        self.disk_cache = cache::DiskCache::new(&self.root, defines_salt(&defines));
        self.client_defines = defines;
        self.base_path = base.to_string();
        self.cache.clear();
        self.inputs.clear();
        Ok(())
    }

    /// nowaki.config `basePath` as given to `set_base_path` (`""` at the root).
    pub fn base_path(&self) -> &str {
        &self.base_path
    }

    /// The server function endpoint the client proxies post to.
    pub(crate) fn server_fn_path(&self) -> String {
        server_fn::fn_path(&self.client_defines)
    }

    /// The URL prefix of emitted assets: `/_nowaki/`, or `<basePath>/_nowaki/`.
    pub fn asset_base(&self) -> String {
        format!("{}/_nowaki/", self.base_path)
    }

    /// Enables remote `?image` imports (and remote images in MDX) for the URLs `remote`'s
    /// patterns allow. Call it before building or serving modules: it resets the source cache.
    pub fn set_remote_images(&mut self, remote: Arc<RemoteImages>) {
        self.remote_salt = remote.salt();
        self.remote = Some(remote);
        self.source_cache.clear();
        self.cache.clear();
        self.inputs.clear();
    }

    /// The remote image settings, when set.
    pub fn remote_images(&self) -> Option<&Arc<RemoteImages>> {
        self.remote.as_ref()
    }

    /// For a remote image import (`https://…?image`, see `resolve::split_remote_spec`): the
    /// cached download with the `?image` options appended, as a local import resolves (fetching
    /// it first on a miss). None for any other specifier. A URL the patterns don't allow is an
    /// error, never fetched.
    pub fn resolve_remote_image(&self, spec: &str) -> Option<Result<PathBuf>> {
        let (url, query) = resolve::split_remote_spec(spec)?;
        let Some(remote) = &self.remote else {
            return Some(Err(anyhow::anyhow!(
                "remote image {url} is not allowed: add a matching entry to images.remotePatterns in nowaki.config"
            )));
        };
        Some(
            remote
                .get(url)
                .map(|file| PathBuf::from(format!("{}?{query}", file.display()))),
        )
    }

    /// Downloads, in one fetcher call, every allowed remote image the app's modules import, so
    /// a build doesn't fetch them one at a time. Imports it can't see (generated by a plugin,
    /// inside packages) are still fetched when the build reaches them.
    fn prefetch_remote_images(&self) -> Result<()> {
        let Some(remote) = self.remote.as_ref().filter(|r| !r.patterns().is_empty()) else {
            return Ok(());
        };
        let mut urls = std::collections::BTreeSet::new();
        for abs in graph::app_sources(&self.root) {
            let Ok(raw) = std::fs::read_to_string(&abs) else {
                continue;
            };
            if !raw.contains("://") {
                continue;
            }
            let Ok(source) = self.read_source(&abs) else {
                continue;
            };
            let Ok(specs) = graph::import_specifiers(&abs, &source) else {
                continue;
            };
            for (spec, _) in specs {
                if let Some((url, _)) = resolve::split_remote_spec(&spec) {
                    if remote.allowed(url) {
                        urls.insert(url.to_string());
                    }
                }
            }
        }
        let urls: Vec<String> = urls.into_iter().collect();
        for r in remote.ensure(&urls) {
            r?;
        }
        Ok(())
    }

    /// Resolves a specifier to an absolute path. Remote image specifiers go to
    /// [`Self::resolve_remote_image`] (an error is printed and gives None). Otherwise tries the
    /// plugin `resolveId` only when oxc resolution fails; virtual ids map to a synthetic path
    /// registered for `read_source`. Without plugins this is plain oxc resolution.
    pub fn resolve_spec(&self, dir: &Path, spec: &str) -> Option<PathBuf> {
        if let Some(r) = self.resolve_remote_image(spec) {
            return r.map_err(|e| eprintln!("[nowaki] {e:#}")).ok();
        }
        if let Ok(r) = self.resolver.resolve(dir, spec) {
            return Some(r.full_path());
        }
        let bridge = self.plugins.as_ref()?;
        let importer = dir.to_string_lossy();
        let id = bridge.resolve_id(spec, &importer)?;
        let p = PathBuf::from(&id);
        if p.is_absolute() && p.exists() {
            return Some(p);
        }
        let hash = format!("{:016x}", xxh3_64(id.as_bytes()));
        let synthetic = self.root.join(VIRTUAL_DIR).join(format!("{hash}.js"));
        self.virtual_ids
            .lock()
            .unwrap()
            .insert(synthetic.clone(), id);
        Some(synthetic)
    }

    /// Returns the original virtual id if this is a synthetic path.
    pub(crate) fn virtual_id_of(&self, abs: &Path) -> Option<String> {
        if !abs.components().any(|c| c.as_os_str() == VIRTUAL_DIR) {
            return None;
        }
        self.virtual_ids.lock().unwrap().get(abs).cloned()
    }

    /// Replaces the `import.meta.env.PUBLIC_*` values read from `.env` with the public values an
    /// app's `env.ts` validated (the CLI's env check). Each pair is `(name, literal)`: the name is
    /// `PUBLIC_` + letters, digits, `_`; the literal is a JSON string, number, boolean, or null,
    /// or `undefined`. Anything else is an error and changes nothing. Call it before building or
    /// serving modules: it resets the transform caches.
    pub fn set_public_env(&mut self, vars: &[(String, String)]) -> Result<()> {
        let mut defines = self.client_defines.clone();
        env::replace_public_defines(&mut defines, vars)?;
        self.disk_cache = cache::DiskCache::new(&self.root, defines_salt(&defines));
        self.client_defines = defines;
        self.cache.clear();
        self.inputs.clear();
        Ok(())
    }

    /// Sets the plugin bridge (called by the CLI when it detects nowaki.config).
    pub fn set_plugins(&mut self, bridge: Arc<dyn PluginBridge>) {
        self.plugins = Some(bridge);
        // Plugins are assumed to depend on the file and on nowaki.config (and the code it imports
        // through it, which a config change re-hashes). A plugin reading other files or the
        // environment should change its output's input too, or the cache can go stale.
        let mut buf = b"plugins".to_vec();
        for name in ["nowaki.config.mjs", "nowaki.config.js"] {
            if let Ok(text) = std::fs::read(self.root.join(name)) {
                buf.extend_from_slice(&text);
            }
        }
        if self.root.join("node_modules/@tsrx/preact").is_dir() {
            buf.extend_from_slice(b"tsrx");
        }
        self.plugin_salt = xxh3_64(&buf);
        self.source_cache.clear();
    }

    /// The hash cache keys use for a file's own text (with the plugin and remote image salts).
    fn raw_hash(&self, text: &str) -> u64 {
        xxh3_64(text.as_bytes()) ^ self.plugin_salt ^ self.remote_salt
    }

    /// A module's source: the file (or a virtual module's `load` output), after MDX and the
    /// plugin hooks, cached by content. Without plugins and outside MDX this is the file's text.
    /// Every source read in dev, build, and chunking goes through here so the hooks apply
    /// consistently.
    pub fn read_source(&self, abs: &Path) -> Result<String> {
        if let Some(vid) = self.virtual_id_of(abs) {
            let bridge = self
                .plugins
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("virtual module but no plugin configured: {vid}"))?;
            let mut source = bridge
                .load(&vid)
                .with_context(|| format!("plugin load hook failed: {vid}"))?
                .ok_or_else(|| anyhow::anyhow!("failed to load virtual module: {vid}"))?;
            // Run generated source through the transform hook too (lets plugins compose).
            if let Some(code) = bridge
                .transform(&vid, &source)
                .with_context(|| format!("plugin transform failed: {vid}"))?
            {
                source = code;
            }
            return Ok(source);
        }
        let raw = std::fs::read_to_string(abs)
            .with_context(|| format!("failed to read: {}", abs.display()))?;
        let rh = self.raw_hash(&raw);
        if let Some(hit) = self.source_cache.get(abs) {
            if hit.0 == rh {
                return Ok(hit.1.clone());
            }
        }
        let source = self.compile_source(abs, raw)?;
        self.source_cache
            .insert(abs.to_path_buf(), (rh, source.clone()));
        Ok(source)
    }

    /// MDX → TSX, then the plugins (or the `.tsrx` compiler), for a file's own text.
    fn compile_source(&self, abs: &Path, raw: String) -> Result<String> {
        let mut source = raw;
        // MDX becomes TSX first; everything after (plugins, oxc, the graph) sees a TSX module.
        if abs.extension().and_then(|e| e.to_str()) == Some("mdx") {
            source = self.mdx_to_tsx(abs, &source)?;
        }
        let is_mdoc = abs.extension().and_then(|e| e.to_str()) == Some("mdoc");
        let Some(bridge) = &self.plugins else {
            if is_mdoc {
                return Err(no_markdoc_plugin(abs));
            }
            return Ok(source);
        };
        let id = abs.to_string_lossy();
        if abs.extension().and_then(|e| e.to_str()) == Some("tsrx") {
            if let Some(code) = bridge
                .compile_tsrx(&id, &source)
                .with_context(|| format!(".tsrx compile failed: {}", abs.display()))?
            {
                return Ok(code);
            }
        } else if is_transformable(abs) {
            if let Some(code) = bridge
                .transform(&id, &source)
                .with_context(|| format!("plugin transform failed: {}", abs.display()))?
            {
                return Ok(code);
            }
        }
        if is_mdoc {
            return Err(no_markdoc_plugin(abs));
        }
        Ok(source)
    }

    /// MDX → TSX. Remote images the patterns allow go through `?image`; other remote images stay
    /// plain `<img>` tags (with a warning when remote patterns are configured).
    fn mdx_to_tsx(&self, abs: &Path, source: &str) -> Result<String> {
        let allowed = |url: &str| {
            let Some(remote) = &self.remote else {
                return false;
            };
            let ok = remote.allowed(url);
            if !ok && !remote.patterns().is_empty() {
                eprintln!(
                    "[nowaki] warning: {}: remote image {url} doesn't match images.remotePatterns; it stays a plain <img>",
                    abs.display()
                );
            }
            ok
        };
        crate::mdx::to_tsx_with_remote(source, &allowed)
            .with_context(|| format!("{}", abs.display()))
    }

    /// A stylesheet's text with its `@import`s inlined (css.rs `inline_imports`), resolving
    /// packages like JS imports do (`lenis/dist/lenis.css`).
    pub fn read_css(&self, abs: &Path) -> Result<String> {
        let css = std::fs::read_to_string(abs)
            .with_context(|| format!("failed to read: {}", abs.display()))?;
        if !css.contains("@import") {
            return Ok(css);
        }
        let resolve = |dir: &Path, spec: &str| self.resolve_spec(dir, spec);
        Ok(css::inline_imports(abs, &css, &resolve))
    }

    /// Reads the file, checks the cache by content hash, and transforms if needed.
    /// Checks memory → disk (survives restarts) → transform, in that order.
    pub fn load_module(&self, abs: &Path, mode: Mode) -> Result<String> {
        // The cache is keyed by the file's own text (and the plugin salt), so a hit returns
        // before anything runs: no plugin-host round trip, no MDX compile. Virtual modules have
        // no file, so their key is the generated source.
        let (hash, pre_read) = if self.virtual_id_of(abs).is_some() {
            let source = self.read_source(abs)?;
            (xxh3_64(source.as_bytes()), Some(source))
        } else {
            let raw = std::fs::read_to_string(abs)
                .with_context(|| format!("failed to read: {}", abs.display()))?;
            (self.raw_hash(&raw), None)
        };
        // Dev browser output also depends on Fast Refresh and on the versions of the imports.
        // Every importer of a bumped module is bumped too, so this module's own version stands
        // for its imports'. Versions only live in this process, so a versioned module skips the
        // disk cache.
        let (hash, versioned) = if mode == Mode::Browser && self.dev_refresh {
            let v = self.dev_version(abs);
            let salted = hash ^ 0x5bd1_e995_7f4a_7c15 ^ v.unwrap_or(0).wrapping_mul(0x9e37_79b9);
            (salted, v.is_some())
        } else {
            (hash, false)
        };
        let key = (abs.to_path_buf(), mode);

        // A hit must also have unchanged inputs: files the output inlines (a CSS Module's class
        // map, `?image` sizes) change without this file changing.
        if let Some(hit) = self.cache.get(&key) {
            if hit.source_hash == hash && self.inputs_fresh(&key) {
                return Ok(hit.code.clone());
            }
        }

        let disk_key = self.disk_cache.key(abs, mode, hash);
        if !versioned {
            if let Some((code, inputs)) = self.disk_cache.get_with_inputs(disk_key) {
                self.remember(key, hash, &code, inputs);
                return Ok(code);
            }
        }

        let source = match pre_read {
            Some(s) => s,
            None => self.read_source(abs)?,
        };
        let dev = transform::DevBrowser {
            refresh: self.dev_refresh,
            versions: (!self.dev_versions.is_empty()).then_some(&self.dev_versions),
        };
        let (code, inputs) = transform::transform_file_dev(
            &self.root,
            abs,
            &source,
            mode,
            &self.resolver,
            &self.client_defines,
            Some(self),
            dev,
        )?;
        if !versioned {
            self.disk_cache.put_with_inputs(disk_key, &code, &inputs);
        }
        self.remember(key, hash, &code, inputs);
        Ok(code)
    }

    /// Whether none of the files the cached module inlines changed since it was cached.
    fn inputs_fresh(&self, key: &(PathBuf, Mode)) -> bool {
        self.inputs
            .get(key)
            .is_none_or(|e| cache::inputs_hash(&e.0) == e.1)
    }

    /// Caches `code` in memory under `key`, with the files it inlines and their current hash.
    fn remember(&self, key: (PathBuf, Mode), hash: u64, code: &str, inputs: Vec<PathBuf>) {
        if inputs.is_empty() {
            self.inputs.remove(&key);
        } else {
            let h = cache::inputs_hash(&inputs);
            self.inputs.insert(key.clone(), (inputs, h));
        }
        self.cache.insert(
            key,
            cache::CachedModule {
                source_hash: hash,
                code: code.to_string(),
            },
        );
    }

    /// Production build: writes the client build to `dist/client/`, server modules to
    /// `dist/server/`, and copies `public/` to `dist/public/`.
    pub fn build(&self, dist: &Path) -> Result<build::BuildReport> {
        Ok(self.build_with_client(dist)?.0)
    }

    /// `build`, plus what the client manifest says (islands, chunks, preloads), for
    /// `budget::route_first_load`.
    pub fn build_with_client(
        &self,
        dist: &Path,
    ) -> Result<(build::BuildReport, build::ClientInfo)> {
        routes::check_url_conflicts(&self.root.join("routes"))?;
        self.prefetch_remote_images()?;
        let (mut report, assets, client) = build::build_client_with_info(self, dist)?;
        report.server_modules = build::build_server(self, dist, &assets)?;
        public::copy_to(&self.root, &dist.join("public"))?;
        Ok((report, client))
    }

    /// For a virtual module, returns it as a `data:` module Node can import directly (for SSR).
    /// None for a real module. Used by the SSR transform and by `build::build_server`.
    pub(crate) fn virtual_ssr_module(&self, dir: &Path, spec: &str) -> Option<String> {
        let p = self.resolve_spec(dir, spec)?;
        self.virtual_id_of(&p)?;
        let src = self.read_source(&p).ok()?;
        Some(transform::data_module(&src))
    }
}

/// Disk cache salt: the nowaki-core version and the client defines, so upgrades and env changes
/// invalidate it.
fn defines_salt(defines: &[(String, String)]) -> u64 {
    let mut buf = env!("CARGO_PKG_VERSION").as_bytes().to_vec();
    for (k, v) in defines {
        buf.extend_from_slice(k.as_bytes());
        buf.extend_from_slice(v.as_bytes());
    }
    xxh3_64(&buf)
}

impl transform::VirtualResolve for NowakiCore {
    fn virtual_browser(&self, dir: &Path, spec: &str) -> Option<PathBuf> {
        self.resolve_spec(dir, spec)
    }
    fn virtual_ssr_module(&self, dir: &Path, spec: &str) -> Option<String> {
        NowakiCore::virtual_ssr_module(self, dir, spec)
    }
    fn remote_image(&self, spec: &str) -> Option<Result<PathBuf>> {
        self.resolve_remote_image(spec)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transformable_extensions() {
        for ext in ["ts", "tsx", "js", "jsx", "mjs", "tsrx", "mdx", "mdoc"] {
            assert!(is_transformable(Path::new(&format!("a.{ext}"))), "{ext}");
        }
        for ext in ["css", "json", "png", "txt", "md"] {
            assert!(!is_transformable(Path::new(&format!("a.{ext}"))), "{ext}");
        }
    }

    #[test]
    fn asset_extensions_case_insensitive() {
        assert!(is_asset(Path::new("logo.svg")));
        assert!(is_asset(Path::new("photo.PNG"))); // uppercase too
        assert!(is_asset(Path::new("font.woff2")));
        assert!(!is_asset(Path::new("mod.ts")));
        assert!(!is_asset(Path::new("style.css"))); // css is not an asset
    }

    /// Mock bridge for testing virtual modules (`resolveId` / `load`) without the Node host.
    struct MockBridge;
    impl PluginBridge for MockBridge {
        fn transform(&self, _id: &str, _code: &str) -> Result<Option<String>> {
            Ok(None)
        }
        fn compile_tsrx(&self, _id: &str, _code: &str) -> Result<Option<String>> {
            Ok(None)
        }
        fn resolve_id(&self, source: &str, _importer: &str) -> Option<String> {
            (source == "virtual:greeting").then(|| source.to_string())
        }
        fn load(&self, id: &str) -> Result<Option<String>> {
            Ok((id == "virtual:greeting").then(|| "export const hi = \"hello\";\n".to_string()))
        }
    }

    /// Counts transform calls, to see a cache hit never reaches the plugin host.
    struct CountingBridge(std::sync::atomic::AtomicUsize);
    impl PluginBridge for CountingBridge {
        fn transform(&self, _id: &str, code: &str) -> Result<Option<String>> {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(Some(code.replace("__MARK__", "\"marked\"")))
        }
        fn compile_tsrx(&self, _id: &str, _code: &str) -> Result<Option<String>> {
            Ok(None)
        }
        fn resolve_id(&self, _source: &str, _importer: &str) -> Option<String> {
            None
        }
        fn load(&self, _id: &str) -> Result<Option<String>> {
            Ok(None)
        }
    }

    #[test]
    fn a_cache_hit_does_not_run_the_plugins() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.ts");
        std::fs::write(&file, "export const x = __MARK__;\n").unwrap();
        let bridge = Arc::new(CountingBridge(Default::default()));
        let mut core = NowakiCore::new(dir.path().to_path_buf());
        core.set_plugins(bridge.clone());
        let calls = || bridge.0.load(std::sync::atomic::Ordering::SeqCst);

        let first = core.load_module(&file, Mode::Browser).unwrap();
        assert!(first.contains("marked"), "{first}");
        assert_eq!(calls(), 1);
        // The graph and chunking read the same module again: still one plugin run.
        core.read_source(&file).unwrap();
        core.load_module(&file, Mode::Browser).unwrap();
        core.load_module(&file, Mode::Ssr).unwrap(); // another mode: a transform, not a plugin run
        assert_eq!(calls(), 1);

        // A new core on the same root (a restart) hits the disk cache without the plugins.
        let mut again = NowakiCore::new(dir.path().to_path_buf());
        again.set_plugins(bridge.clone());
        assert_eq!(again.load_module(&file, Mode::Browser).unwrap(), first);
        assert_eq!(calls(), 1);

        // Editing the file runs them again.
        std::fs::write(&file, "export const x = __MARK__ + 1;\n").unwrap();
        assert!(core
            .load_module(&file, Mode::Browser)
            .unwrap()
            .contains("+ 1"));
        assert_eq!(calls(), 2);
    }

    #[test]
    fn virtual_module_resolves_and_loads() {
        let mut core = NowakiCore::new(std::env::temp_dir().join("nowaki-virtual-test"));
        core.set_plugins(Arc::new(MockBridge));
        let dir = core.root.clone();

        // A virtual id that can't be resolved normally goes to a synthetic path via resolveId.
        let p = core
            .resolve_spec(&dir, "virtual:greeting")
            .expect("virtual id should resolve via the plugin");
        assert!(
            p.components().any(|c| c.as_os_str() == VIRTUAL_DIR),
            "virtual id should map under the synthetic dir: {}",
            p.display()
        );
        // read_source returns the load hook's content (doesn't read disk).
        let src = core.read_source(&p).expect("virtual load");
        assert!(src.contains("hello"), "load() source expected: {src}");
        // Unclaimed specifiers yield None (= normal resolution failure).
        assert!(core.resolve_spec(&dir, "virtual:unknown").is_none());
    }

    /// A plugin host that can't answer (it crashed, a plugin threw).
    struct FailingBridge;
    impl PluginBridge for FailingBridge {
        fn transform(&self, _id: &str, _code: &str) -> Result<Option<String>> {
            Err(anyhow::anyhow!("plugin host unreachable"))
        }
        fn compile_tsrx(&self, _id: &str, _code: &str) -> Result<Option<String>> {
            Err(anyhow::anyhow!("plugin host unreachable"))
        }
    }

    #[test]
    fn a_failed_plugin_transform_is_an_error_not_the_raw_source() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.ts");
        std::fs::write(&file, "export const x = __MARK__;\n").unwrap();
        let mut core = NowakiCore::new(dir.path().to_path_buf());
        core.set_plugins(Arc::new(FailingBridge));

        let err = core.read_source(&file).unwrap_err();
        assert!(
            format!("{err:#}").contains("plugin host unreachable"),
            "{err:#}"
        );
        let err = core.load_module(&file, Mode::Browser).unwrap_err();
        assert!(
            format!("{err:#}").contains("plugin transform failed"),
            "{err:#}"
        );
    }

    /// SSR inlines a CSS Module's class map (with its `@import`s) and `?image` sizes into the
    /// importer, so editing those files must invalidate the importer's cache entry, in memory
    /// and on disk, though the importer itself didn't change.
    #[test]
    fn the_transform_cache_sees_changes_to_inlined_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        let file = root.join("a.tsx");
        std::fs::write(&file, "import s from \"./a.module.css\";\nimport img from \"./p.png?image\";\nexport const x = [s, img];\n").unwrap();
        std::fs::write(root.join("a.module.css"), "@import \"./base.css\";\n").unwrap();
        std::fs::write(root.join("base.css"), ".first { color: red }\n").unwrap();
        let png = |w: u32| {
            ::image::RgbImage::new(w, 1)
                .save(root.join("p.png"))
                .unwrap()
        };
        png(3);

        let core = NowakiCore::new(root.clone());
        let before = core.load_module(&file, Mode::Ssr).unwrap();
        assert!(before.contains("first"), "{before}");
        assert!(before.contains("width%3A%203"), "{before}");

        std::fs::write(root.join("base.css"), ".second { color: red }\n").unwrap();
        png(5);
        let after = core.load_module(&file, Mode::Ssr).unwrap();
        assert!(
            after.contains("second") && !after.contains("first"),
            "stale class map in memory:\n{after}"
        );
        assert!(
            after.contains("width%3A%205"),
            "stale ?image size in memory:\n{after}"
        );

        // A restart reads the disk cache: it must not return the first entry either.
        std::fs::write(root.join("base.css"), ".first { color: red }\n").unwrap();
        png(3);
        let _ = NowakiCore::new(root.clone())
            .load_module(&file, Mode::Ssr)
            .unwrap();
        std::fs::write(root.join("base.css"), ".third { color: red }\n").unwrap();
        let restarted = NowakiCore::new(root.clone())
            .load_module(&file, Mode::Ssr)
            .unwrap();
        assert!(
            restarted.contains("third"),
            "stale class map from the disk cache:\n{restarted}"
        );
    }

    /// Browser output holds resolved import URLs, so after an install changes the dependency
    /// layout (lockfile and node_modules), a restart must not serve the old URLs from disk.
    #[test]
    fn the_disk_cache_is_dropped_when_dependencies_are_reinstalled() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(dir.path()).unwrap();
        let file = root.join("a.ts");
        std::fs::write(&file, "import { v } from \"pkg\";\nexport const x = v;\n").unwrap();
        let pkg = root.join("node_modules/pkg");
        std::fs::create_dir_all(&pkg).unwrap();
        let install = |main: &str, lock: &str| {
            std::fs::write(
                pkg.join("package.json"),
                format!("{{\"name\":\"pkg\",\"main\":\"{main}\"}}"),
            )
            .unwrap();
            std::fs::write(pkg.join(main), "export const v = 1;\n").unwrap();
            std::fs::write(root.join("package-lock.json"), lock).unwrap();
        };
        install("one.js", "{\"lockfileVersion\":3,\"v\":1}");
        let first = NowakiCore::new(root.clone())
            .load_module(&file, Mode::Browser)
            .unwrap();
        assert!(first.contains("/node_modules/pkg/one.js"), "{first}");

        install("two.js", "{\"lockfileVersion\":3,\"v\":2}");
        let after = NowakiCore::new(root.clone())
            .load_module(&file, Mode::Browser)
            .unwrap();
        assert!(
            after.contains("/node_modules/pkg/two.js"),
            "stale import URL from the disk cache:\n{after}"
        );
    }

    #[test]
    fn an_mdoc_file_without_a_markdoc_plugin_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("page.mdoc");
        std::fs::write(&file, "# Hello\n").unwrap();
        let core = NowakiCore::new(dir.path().to_path_buf());
        let err = core.read_source(&file).unwrap_err();
        assert!(
            format!("{err:#}").contains("add @nowaki-dev/markdoc to plugins"),
            "{err:#}"
        );

        // Plugins that leave it alone count as no plugin.
        let mut core = NowakiCore::new(dir.path().to_path_buf());
        core.set_plugins(Arc::new(MockBridge));
        let err = core.load_module(&file, Mode::Ssr).unwrap_err();
        assert!(
            format!("{err:#}").contains("add @nowaki-dev/markdoc to plugins"),
            "{err:#}"
        );

        // A plugin's output is an ordinary module.
        let mut core = NowakiCore::new(dir.path().to_path_buf());
        core.set_plugins(Arc::new(CountingBridge(Default::default())));
        std::fs::write(&file, "export const x = __MARK__;\n").unwrap();
        assert!(core
            .load_module(&file, Mode::Ssr)
            .unwrap()
            .contains("marked"));
    }
}
