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

/// A hash of `inputs`' paths and contents (0 for none). A missing file hashes differently from
/// any content, so creating or deleting one changes it too.
pub fn inputs_hash(inputs: &[PathBuf]) -> u64 {
    if inputs.is_empty() {
        return 0;
    }
    let mut buf = Vec::with_capacity(inputs.len() * 64);
    for p in inputs {
        buf.extend_from_slice(p.to_string_lossy().as_bytes());
        buf.push(0);
        match std::fs::read(p) {
            Ok(bytes) => {
                buf.push(1);
                buf.extend_from_slice(&xxh3_64(&bytes).to_le_bytes());
            }
            Err(_) => buf.push(2),
        }
    }
    xxh3_64(&buf)
}

/// (absolute path, mode) → transform result. Content hashes invalidate entries automatically,
/// so no explicit invalidation by the watcher is needed.
pub type ModuleCache = DashMap<(PathBuf, Mode), CachedModule>;

/// For a [`ModuleCache`] entry whose code inlines other files (CSS Module class maps, `?image`
/// sizes; see `transform::transform_file_with_inputs`): those files and [`inputs_hash`] of them
/// when it was cached. The entry is fresh only while the hash still matches.
pub type InputsCache = DashMap<(PathBuf, Mode), (Vec<PathBuf>, u64)>;

/// Persistent transform cache that survives restarts. Content-addressed, so it doesn't depend on mtime;
/// entries are reused when source, mode, and salt (nowaki version + defines) match.
/// Stored in `node_modules/.cache/nowaki/` (disabled with a fallback if unavailable).
pub struct DiskCache {
    dir: Option<PathBuf>,
    salt: u64,
}

impl DiskCache {
    /// The salt mixes in the nowaki version + a hash of client_defines
    /// (so upgrades and env changes invalidate the cache automatically), and here
    /// [`resolution_fingerprint`] (so does an install that changes where imports resolve).
    pub fn new(root: &Path, salt: u64) -> Self {
        let dir = root.join("node_modules/.cache/nowaki");
        let dir = std::fs::create_dir_all(&dir).ok().map(|_| dir);
        let mut buf = salt.to_le_bytes().to_vec();
        buf.extend_from_slice(&resolution_fingerprint(root).to_le_bytes());
        Self {
            dir,
            salt: xxh3_64(&buf),
        }
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

    /// The cached code for `key` and the inputs it inlines. A module with inputs is stored under
    /// `key` mixed with [`inputs_hash`] of them (the list itself is in `<key>.inputs`), so an
    /// entry whose inlined files changed is never returned.
    /// The cached code for `key` (see [`DiskCache::get_with_inputs`]).
    pub fn get(&self, key: u64) -> Option<String> {
        self.get_with_inputs(key).map(|(code, _)| code)
    }

    /// Stores `code` for `key` for a module that inlines no other file.
    pub fn put(&self, key: u64, code: &str) {
        self.put_with_inputs(key, code, &[]);
    }

    pub fn get_with_inputs(&self, key: u64) -> Option<(String, Vec<PathBuf>)> {
        let dir = self.dir.as_ref()?;
        let inputs: Vec<PathBuf> =
            match std::fs::read_to_string(dir.join(format!("{key:016x}.inputs"))) {
                Ok(list) => list.lines().map(PathBuf::from).collect(),
                Err(_) => Vec::new(),
            };
        let file = entry_key(key, &inputs);
        let code = std::fs::read_to_string(dir.join(format!("{file:016x}.js"))).ok()?;
        Some((code, inputs))
    }

    pub fn put_with_inputs(&self, key: u64, code: &str, inputs: &[PathBuf]) {
        if let Some(dir) = &self.dir {
            // A write failure isn't fatal (it just degrades to no cache)
            let list = dir.join(format!("{key:016x}.inputs"));
            if inputs.is_empty() {
                let _ = std::fs::remove_file(list);
            } else {
                let paths: Vec<String> = inputs
                    .iter()
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect();
                let _ = std::fs::write(list, paths.join("\n"));
            }
            let file = entry_key(key, inputs);
            let _ = std::fs::write(dir.join(format!("{file:016x}.js")), code);
        }
    }
}

/// The file key of a disk entry: `key` itself without inputs, else mixed with their hash.
fn entry_key(key: u64, inputs: &[PathBuf]) -> u64 {
    if inputs.is_empty() {
        return key;
    }
    let mut buf = key.to_le_bytes().to_vec();
    buf.extend_from_slice(&inputs_hash(inputs).to_le_bytes());
    xxh3_64(&buf)
}

/// Lockfiles and the state files package managers write into node_modules on every install.
const INSTALL_FILES: &[&str] = &[
    "pnpm-lock.yaml",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
    "node_modules/.modules.yaml",
    "node_modules/.package-lock.json",
    "node_modules/.yarn-state.yml",
];

/// A hash of what import resolution depends on beyond the importing file: the app's
/// `package.json` (`imports`) and `tsconfig.json` (`paths`), and the lockfiles / install state
/// in the root and every directory above it (a workspace keeps its lockfile at the top). Browser
/// output holds resolved URLs (`/node_modules/.pnpm/pkg@1.0.0/…`), so an install that moves a
/// dependency must not reuse entries from before it.
pub fn resolution_fingerprint(root: &Path) -> u64 {
    let mut buf = Vec::new();
    let mut add = |p: &Path| {
        if let Ok(bytes) = std::fs::read(p) {
            buf.extend_from_slice(p.to_string_lossy().as_bytes());
            buf.extend_from_slice(&xxh3_64(&bytes).to_le_bytes());
        }
    };
    add(&root.join("package.json"));
    add(&root.join("tsconfig.json"));
    for dir in root.ancestors() {
        for name in INSTALL_FILES {
            add(&dir.join(name));
        }
    }
    xxh3_64(&buf)
}
