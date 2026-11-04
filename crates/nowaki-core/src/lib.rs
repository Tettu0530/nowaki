pub mod asset;
pub mod build;
pub mod cache;
pub mod chunk;
pub mod compress;
pub mod css;
pub mod env;
pub mod graph;
pub mod resolve;
pub mod routes;
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
pub trait PluginBridge: Send + Sync {
    /// The `transform(code, id)` hook for transformable sources (ts/tsx/js/jsx/mjs).
    /// None if no plugin changed it.
    fn transform(&self, id: &str, code: &str) -> Option<String>;

    /// Compiles `.tsrx` source to standard JSX with `@tsrx/preact`. The output then goes
    /// through oxc's JSX→preact pipeline. None if the compiler isn't installed.
    fn compile_tsrx(&self, id: &str, code: &str) -> Option<String>;

    /// `resolveId(source, importer)` for virtual modules. If a plugin claims the specifier, returns
    /// the resolved id (a real path or a virtual id string). None if no plugin claims it.
    /// Called only when normal resolution fails (= never touches on-disk modules).
    fn resolve_id(&self, _source: &str, _importer: &str) -> Option<String> {
        None
    }

    /// `load(id)` for virtual modules. Returns the source for a virtual id from `resolveId`. None if unsupported.
    fn load(&self, _id: &str) -> Option<String> {
        None
    }
}

/// Extensions to transform. Anything else (css, images, etc.) is served as is.
/// `.tsrx` is compiled to JSX by `@tsrx/preact` in the plugin host, then run through oxc.
pub fn is_transformable(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("ts" | "tsx" | "js" | "jsx" | "mjs" | "tsrx")
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
    /// Persistent cache that survives restarts
    disk_cache: cache::DiskCache,
    /// Client constant-replacement pairs for import.meta.env.PUBLIC_* / MODE (from .env)
    pub(crate) client_defines: Vec<(String, String)>,
    /// Plugin transform hooks (optional). If unset, files are read as is.
    plugins: Option<Arc<dyn PluginBridge>>,
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
        Self {
            root,
            resolver: resolve::make_resolver(),
            cache: cache::ModuleCache::default(),
            disk_cache,
            client_defines,
            plugins: None,
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
                .ok_or_else(|| anyhow::anyhow!("failed to load virtual module: {vid}"))?;
            // Run generated source through the transform hook too (lets plugins compose).
            if let Some(code) = bridge.transform(&vid, &source) {
                source = code;
            }
            return Ok(source);
        }
        let source = std::fs::read_to_string(abs)
            .with_context(|| format!("failed to read: {}", abs.display()))?;
        let Some(bridge) = &self.plugins else {
            return Ok(source);
        };
        let id = abs.to_string_lossy();
        if abs.extension().and_then(|e| e.to_str()) == Some("tsrx") {
            if let Some(code) = bridge.compile_tsrx(&id, &source) {
                return Ok(code);
            }
        } else if is_transformable(abs) {
            if let Some(code) = bridge.transform(&id, &source) {
                return Ok(code);
            }
        }
        Ok(source)
    }

    /// Reads the file, checks the cache by content hash, and transforms if needed.
    /// Checks memory → disk (survives restarts) → transform, in that order.
    pub fn load_module(&self, abs: &Path, mode: Mode) -> Result<String> {
        // read_source returns the source after plugin transforms. The hash is taken from that
        // content too, so either a file change or a plugin output change correctly invalidates the cache.
        let source = self.read_source(abs)?;
        let hash = xxh3_64(source.as_bytes());
        let key = (abs.to_path_buf(), mode);

        if let Some(hit) = self.cache.get(&key) {
            if hit.source_hash == hash {
                return Ok(hit.code.clone());
            }
        }

        let disk_key = self.disk_cache.key(abs, mode, hash);
        if let Some(code) = self.disk_cache.get(disk_key) {
            self.cache.insert(
                key,
                cache::CachedModule {
                    source_hash: hash,
                    code: code.clone(),
                },
            );
            return Ok(code);
        }

        let code = transform::transform_file(
            &self.root,
            abs,
            &source,
            mode,
            &self.resolver,
            &self.client_defines,
            Some(self),
        )?;
        self.cache.insert(
            key,
            cache::CachedModule {
                source_hash: hash,
                code: code.clone(),
            },
        );
        self.disk_cache.put(disk_key, &code);
        Ok(code)
    }

    /// Production build: writes the client graph to dist/client/ and server modules
    /// to dist/server/.
    pub fn build(&self, dist: &Path) -> Result<build::BuildReport> {
        let (mut report, assets) = build::build_client(self, dist)?;
        report.server_modules = build::build_server(self, dist, &assets)?;
        Ok(report)
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
        for ext in ["ts", "tsx", "js", "jsx", "mjs", "tsrx"] {
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
        fn transform(&self, _id: &str, _code: &str) -> Option<String> {
            None
        }
        fn compile_tsrx(&self, _id: &str, _code: &str) -> Option<String> {
            None
        }
        fn resolve_id(&self, source: &str, _importer: &str) -> Option<String> {
            (source == "virtual:greeting").then(|| source.to_string())
        }
        fn load(&self, id: &str) -> Option<String> {
            (id == "virtual:greeting").then(|| "export const hi = \"hello\";\n".to_string())
        }
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
}
