//! Module resolution helpers: the oxc resolver, the React → Preact aliases, remote image
//! specifiers, and the dev server's file URLs.

use std::path::{Path, PathBuf};

use oxc_resolver::{ResolveOptions, Resolver};

/// The oxc resolver every transform uses: browser ESM conditions and main fields, and the TS,
/// JSX, `.tsrx`, and JSON extensions. The SSR transform and the server build use it too.
pub fn make_resolver() -> Resolver {
    Resolver::new(ResolveOptions {
        extensions: vec![
            ".tsx".into(),
            ".ts".into(),
            ".jsx".into(),
            ".js".into(),
            ".mjs".into(),
            ".tsrx".into(),
            ".json".into(),
        ],
        condition_names: vec![
            "browser".into(),
            "import".into(),
            "module".into(),
            "default".into(),
        ],
        main_fields: vec!["module".into(), "browser".into(), "main".into()],
        ..ResolveOptions::default()
    })
}

/// Maps React bare imports to Preact-compatible ones, so code ported from Next.js and
/// React-dependent libraries run as is through `react` → `preact/compat`. If it returns Some, use
/// that specifier instead (applied to the specifier, before resolution). SSR of node_modules uses
/// the same table (`server/react-alias-hooks.mjs` in the runtime); keep them in sync.
pub fn alias_specifier(spec: &str) -> Option<&'static str> {
    match spec {
        "react" | "react-dom" => Some("preact/compat"),
        "react-dom/client" => Some("preact/compat/client"),
        "react-dom/server" => Some("preact/compat/server"),
        "react-dom/test-utils" => Some("preact/test-utils"),
        "react/jsx-runtime" => Some("preact/jsx-runtime"),
        "react/jsx-dev-runtime" => Some("preact/jsx-dev-runtime"),
        "react/compiler-runtime" => Some("preact/compat/compiler-runtime"),
        "scheduler" => Some("preact/compat/scheduler"),
        _ => None,
    }
}

/// Splits a remote image import (`https://cdn.example.com/a.jpg?image&w=400`) into the URL to
/// fetch and the `?image` options (without `?`). Nowaki's options start at the `image` key;
/// anything before it belongs to the remote URL (`…/a.jpg?v=2&image` fetches `…/a.jpg?v=2`).
/// None for anything else, including remote imports without `image` (left as URL imports).
pub fn split_remote_spec(spec: &str) -> Option<(&str, &str)> {
    if !(spec.starts_with("https://") || spec.starts_with("http://")) {
        return None;
    }
    let q = spec.find('?')?;
    let mut start = q + 1;
    loop {
        let end = spec[start..].find('&').map_or(spec.len(), |i| start + i);
        let key = spec[start..end].split('=').next().unwrap_or("");
        if key == "image" {
            let url = &spec[..start - 1];
            return (!url.is_empty()).then_some((url, &spec[start..]));
        }
        if end == spec.len() {
            return None;
        }
        start = end + 1;
    }
}

/// Client builds only: `preact/jsx-runtime` resolves to the runtime's tiny `createElement`
/// wrapper (`client/jsx-runtime.js`) instead of Preact's own module, which saves about 0.9 KB gzip
/// on every page with an island. None when the runtime's file isn't installed.
pub fn client_runtime_alias(root: &Path, spec: &str) -> Option<PathBuf> {
    if spec != "preact/jsx-runtime" && spec != "preact/jsx-dev-runtime" {
        return None;
    }
    let shim = root.join("node_modules/@nowaki-dev/runtime/client/jsx-runtime.js");
    shim.exists()
        .then(|| dunce::canonicalize(&shim).unwrap_or(shim))
}

/// Maps a resolved absolute path to a dev server URL.
/// - Under the app root → root-relative URL (`/islands/Counter.tsx`).
/// - Outside the root (real paths into the pnpm store etc.) → `/@fs/<absolute path>`.
pub fn fs_path_to_url(root: &Path, abs: &Path) -> String {
    match abs.strip_prefix(root) {
        Ok(rel) => format!("/{}", url_slashes(rel)),
        // POSIX paths start with `/`; Windows ones (`D:/...`) don't.
        Err(_) => format!("/@fs/{}", url_slashes(abs).trim_start_matches('/')),
    }
}

/// Inverse of the `/@fs/` mapping for the part after `/@fs/`.
pub fn fs_url_to_path(rest: &str) -> std::path::PathBuf {
    if cfg!(windows) && has_drive_prefix(rest) {
        std::path::PathBuf::from(rest)
    } else {
        std::path::PathBuf::from(format!("/{rest}"))
    }
}

fn has_drive_prefix(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'/' || b[2] == b'\\')
}

fn url_slashes(p: &Path) -> String {
    let s = p.to_string_lossy();
    // A backslash is a valid file name character on POSIX, so only Windows separators are
    // rewritten.
    if cfg!(windows) {
        s.replace('\\', "/")
    } else {
        s.into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn react_family_aliases_to_preact() {
        assert_eq!(alias_specifier("react"), Some("preact/compat"));
        assert_eq!(alias_specifier("react-dom"), Some("preact/compat"));
        assert_eq!(
            alias_specifier("react-dom/client"),
            Some("preact/compat/client")
        );
        assert_eq!(
            alias_specifier("react-dom/server"),
            Some("preact/compat/server")
        );
        assert_eq!(
            alias_specifier("scheduler"),
            Some("preact/compat/scheduler")
        );
        assert_eq!(
            alias_specifier("react/jsx-runtime"),
            Some("preact/jsx-runtime")
        );
        assert_eq!(
            alias_specifier("react/jsx-dev-runtime"),
            Some("preact/jsx-dev-runtime")
        );
        assert_eq!(
            alias_specifier("react-dom/test-utils"),
            Some("preact/test-utils")
        );
        assert_eq!(
            alias_specifier("react/compiler-runtime"),
            Some("preact/compat/compiler-runtime")
        );
    }

    #[test]
    fn non_react_specifiers_are_not_aliased() {
        assert_eq!(alias_specifier("preact"), None);
        assert_eq!(alias_specifier("preact/hooks"), None);
        assert_eq!(alias_specifier("./local.tsx"), None);
        assert_eq!(alias_specifier("lodash"), None);
        // No aliasing on partial matches.
        assert_eq!(alias_specifier("react-icons"), None);
    }

    #[test]
    fn splits_remote_image_specifiers() {
        assert_eq!(
            split_remote_spec("https://cdn.example.com/a.jpg?image"),
            Some(("https://cdn.example.com/a.jpg", "image"))
        );
        assert_eq!(
            split_remote_spec("https://cdn.example.com/a.jpg?v=2&image&w=400"),
            Some(("https://cdn.example.com/a.jpg?v=2", "image&w=400"))
        );
        assert_eq!(
            split_remote_spec("http://127.0.0.1:4860/a.png?image=1"),
            Some(("http://127.0.0.1:4860/a.png", "image=1"))
        );
        assert_eq!(split_remote_spec("https://cdn.example.com/a.jpg"), None);
        assert_eq!(
            split_remote_spec("https://cdn.example.com/a.jpg?images"),
            None
        );
        assert_eq!(split_remote_spec("./a.jpg?image"), None);
        assert_eq!(split_remote_spec("//cdn.example.com/a.jpg?image"), None);
    }

    #[test]
    fn fs_path_to_url_maps_under_root_and_outside() {
        let root = PathBuf::from("/app");
        assert_eq!(
            fs_path_to_url(&root, &PathBuf::from("/app/islands/Counter.tsx")),
            "/islands/Counter.tsx"
        );
        assert_eq!(
            fs_path_to_url(&root, &PathBuf::from("/store/preact/index.js")),
            "/@fs/store/preact/index.js"
        );
    }

    #[test]
    fn drive_prefix_detection() {
        assert!(has_drive_prefix("D:/a/node_modules/x.js"));
        assert!(has_drive_prefix("c:\\x"));
        assert!(!has_drive_prefix("store/preact/index.js"));
        assert!(!has_drive_prefix("D:"));
    }

    #[cfg(not(windows))]
    #[test]
    fn fs_url_round_trips_on_posix() {
        let root = PathBuf::from("/app");
        let url = fs_path_to_url(&root, &PathBuf::from("/store/p.js"));
        assert_eq!(
            fs_url_to_path(url.strip_prefix("/@fs/").unwrap()),
            PathBuf::from("/store/p.js")
        );
        // A drive-looking path is not special on POSIX.
        assert_eq!(fs_url_to_path("C:/x"), PathBuf::from("/C:/x"));
    }

    #[cfg(windows)]
    #[test]
    fn fs_url_round_trips_on_windows() {
        let root = PathBuf::from(r"D:\app");
        assert_eq!(
            fs_path_to_url(&root, &PathBuf::from(r"D:\app\islands\Counter.tsx")),
            "/islands/Counter.tsx"
        );
        let url = fs_path_to_url(&root, &PathBuf::from(r"D:\store\p.js"));
        assert_eq!(url, "/@fs/D:/store/p.js");
        assert_eq!(
            fs_url_to_path(url.strip_prefix("/@fs/").unwrap()),
            PathBuf::from("D:/store/p.js")
        );
    }
}
