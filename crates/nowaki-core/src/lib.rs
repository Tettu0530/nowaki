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

/// Synthetic directory name for plugin virtual modules (doesn't exist on disk).
/// A virtual id returned by `resolveId` maps to `<root>/__nowaki_virtual__/<hash>.js`;
/// `read_source` looks up the original id in the registry and gets the source from the `load` hook.
pub const VIRTUAL_DIR: &str = "__nowaki_virtual__";

/// Bridge for calling plugin transform hooks from Rust. The CLI implements it by delegating
/// over HTTP to the Node plugin host (which loads `nowaki.config`).
/// nowaki-core itself runs no JS, so this trait keeps them loosely coupled.
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
    /// the resolved id (a real path or a virtual id string). None if no plugin claims it.
    /// Called only when normal resolution fails (= never touches on-disk modules).
    fn resolve_id(&self, _source: &str, _importer: &str) -> Option<String> {
        None
    }

    /// `load(id)` for virtual modules. Returns the source for a virtual id from `resolveId`.
    /// `Ok(None)` if unsupported.
    fn load(&self, _id: &str) -> Result<Option<String>> {
        Ok(None)
    }
}

/// Extensions to transform. Anything else (css, images, etc.) is served as is.
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

/// Assets treated as URL strings on import (images, fonts, media).
/// In `import logo from "./logo.png"`, logo is the served URL.
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

/// Bundler core. Used by both the dev server and build.
pub struct NowakiCore {
    pub root: PathBuf,
    resolver: Resolver,
    cache: cache::ModuleCache,
    /// The files each cached module inlines (see `remember`).
    inputs: cache::InputsCache,
    /// Persistent cache that survives restarts
    disk_cache: cache::DiskCache,
    /// Client constant-replacement pairs for import.meta.env.PUBLIC_* / MODE (from .env)
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
    /// Virtual module synthetic path → original id (as returned by `resolveId`). Kept for lookup in `load`.
    virtual_ids: Mutex<HashMap<PathBuf, String>>,
}

impl NowakiCore {
    pub fn new(root: PathBuf) -> Self {
        // Resolved module paths are canonical, so the root must be too, or `root.starts_with`
        // checks (which modules are the app's, and get hoisted) miss through a symlinked path
        // (macOS /var → /private/var) or a Windows verbatim `\\?\C:\…` one. dunce keeps Windows
        // paths in their normal form. A root that doesn't exist yet is kept as given.
        let root = dunce::canonicalize(&root).unwrap_or(root);
        let client_defines = env::load_client_defines(&root);
        // salt = nowaki version + defines. Upgrades/env changes invalidate the disk cache.
        let mut salt_buf = env!("CARGO_PKG_VERSION").as_bytes().to_vec();
        for (k, v) in &client_defines {
            salt_buf.extend_from_slice(k.as_bytes());
            salt_buf.extend_from_slice(v.as_bytes());
        }
        let disk_cache = cache::DiskCache::new(&root, xxh3_64(&salt_buf));
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
        }
    }

    /// Resolves a specifier to an absolute path. Tries the plugin `resolveId` only when normal oxc
    /// resolution fails; virtual ids map to a synthetic path registered for `read_source`.
    /// Without plugins this is identical to plain resolution (zero overhead).
    pub fn resolve_spec(&self, dir: &Path, spec: &str) -> Option<PathBuf> {
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

    /// Sets the plugin transform bridge (called by the CLI when it detects nowaki.config).
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

    /// The hash cache keys use for a file's own text (with the plugin salt).
    fn raw_hash(&self, text: &str) -> u64 {
        xxh3_64(text.as_bytes()) ^ self.plugin_salt
    }

    /// Gets a module's source (file read + plugin transform hook).
    /// Without plugins this is identical to a plain file read (= unchanged behavior). All source
    /// reads in dev/build/chunk go through here so transform hooks apply consistently.
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
            source = crate::mdx::to_tsx(&source).with_context(|| format!("{}", abs.display()))?;
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
        let key = (abs.to_path_buf(), mode);

        // A hit must also have unchanged inputs: files the output inlines (a CSS Module's class
        // map, `?image` sizes) change without this file changing.
        if let Some(hit) = self.cache.get(&key) {
            if hit.source_hash == hash && self.inputs_fresh(&key) {
                return Ok(hit.code.clone());
            }
        }

        let disk_key = self.disk_cache.key(abs, mode, hash);
        if let Some((code, inputs)) = self.disk_cache.get_with_inputs(disk_key) {
            self.remember(key, hash, &code, inputs);
            return Ok(code);
        }

        let source = match pre_read {
            Some(s) => s,
            None => self.read_source(abs)?,
        };
        let (code, inputs) = transform::transform_file_with_inputs(
            &self.root,
            abs,
            &source,
            mode,
            &self.resolver,
            &self.client_defines,
            Some(self),
        )?;
        self.disk_cache.put_with_inputs(disk_key, &code, &inputs);
        self.remember(key, hash, &code, inputs);
        Ok(code)
    }

    /// Whether none of the files the cached module inlines changed since it was cached.
    fn inputs_fresh(&self, key: &(PathBuf, Mode)) -> bool {
        self.inputs
            .get(key)
            .is_none_or(|e| cache::inputs_hash(&e.0) == e.1)
    }

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

    /// Production build: writes the client graph to dist/client/ and server modules
    /// to dist/server/.
    pub fn build(&self, dist: &Path) -> Result<build::BuildReport> {
        Ok(self.build_with_client(dist)?.0)
    }

    /// `build`, plus what the client manifest says (islands, chunks, preloads), for
    /// `budget::route_first_load`.
    pub fn build_with_client(
        &self,
        dist: &Path,
    ) -> Result<(build::BuildReport, build::ClientInfo)> {
        let (mut report, assets, client) = build::build_client_with_info(self, dist)?;
        report.server_modules = build::build_server(self, dist, &assets)?;
        public::copy_to(&self.root, &dist.join("public"))?;
        Ok((report, client))
    }

    /// For a virtual module, returns it as a data: module Node can import directly (for SSR).
    /// None for a real module (normally resolvable). Also used by build_server.
    pub(crate) fn virtual_ssr_module(&self, dir: &Path, spec: &str) -> Option<String> {
        let p = self.resolve_spec(dir, spec)?;
        self.virtual_id_of(&p)?;
        let src = self.read_source(&p).ok()?;
        Some(transform::data_module(&src))
    }
}

impl transform::VirtualResolve for NowakiCore {
    fn virtual_browser(&self, dir: &Path, spec: &str) -> Option<PathBuf> {
        self.resolve_spec(dir, spec)
    }
    fn virtual_ssr_module(&self, dir: &Path, spec: &str) -> Option<String> {
        NowakiCore::virtual_ssr_module(self, dir, spec)
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

    // Mock bridge for testing virtual modules (resolveId/load) without the Node host.
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
