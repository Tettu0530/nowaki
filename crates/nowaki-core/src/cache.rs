use std::path::{Path, PathBuf};

use dashmap::DashMap;
use xxhash_rust::xxh3::xxh3_64;

/// Transform mode. Browser rewrites bare imports to URLs; Ssr leaves them to Node resolution.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Mode {
    Browser,
    Ssr,
}

impl Mode {
    fn tag(self) -> u8 {
        match self {
            Mode::Browser => 0,
            Mode::Ssr => 1,
        }
    }
}

pub struct CachedModule {
    /// xxh3 hash of the source. Used to check freshness when the file is re-read.
    pub source_hash: u64,
    pub code: String,
}

/// (absolute path, mode) → transform result. Content hashes invalidate entries automatically,
/// so no explicit invalidation by the watcher is needed.
pub type ModuleCache = DashMap<(PathBuf, Mode), CachedModule>;

/// Persistent transform cache that survives restarts. Content-addressed, so it doesn't depend on mtime;
/// entries are reused when source, mode, and salt (nowaki version + defines) match.
/// Stored in `node_modules/.cache/nowaki/` (disabled with a fallback if unavailable).
pub struct DiskCache {
    dir: Option<PathBuf>,
    salt: u64,
}

impl DiskCache {
    /// The salt mixes in the nowaki version + a hash of client_defines
    /// (so upgrades and env changes invalidate the cache automatically).
    pub fn new(root: &Path, salt: u64) -> Self {
        let dir = root.join("node_modules/.cache/nowaki");
        let dir = std::fs::create_dir_all(&dir).ok().map(|_| dir);
        Self { dir, salt }
    }

    /// Builds a cache key from (absolute path, mode, source hash).
    pub fn key(&self, abs: &Path, mode: Mode, source_hash: u64) -> u64 {
        let mut buf = Vec::with_capacity(64);
        buf.extend_from_slice(&self.salt.to_le_bytes());
        buf.push(mode.tag());
        buf.extend_from_slice(&source_hash.to_le_bytes());
        buf.extend_from_slice(abs.to_string_lossy().as_bytes());
        xxh3_64(&buf)
    }

    pub fn get(&self, key: u64) -> Option<String> {
        let dir = self.dir.as_ref()?;
        std::fs::read_to_string(dir.join(format!("{key:016x}.js"))).ok()
    }

    pub fn put(&self, key: u64, code: &str) {
        if let Some(dir) = &self.dir {
            // A write failure isn't fatal (it just degrades to no cache)
            let _ = std::fs::write(dir.join(format!("{key:016x}.js")), code);
        }
    }
}
