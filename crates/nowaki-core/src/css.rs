//! CSS handling: `@import` inlining, CSS Modules scoping, and the JS modules that inject
//! stylesheets in the browser.

use std::path::Path;

use xxhash_rust::xxh3::xxh3_64;

/// Inlines `@import`s at the top of a stylesheet, recursively: `@import "./tokens.css";`,
/// `@import url(x) screen;`, `@import "pkg/dist/x.css" layer(base);`. A served stylesheet lives at
/// a hashed URL (or `/__nowaki/css` in dev), so an import left as written would resolve against
/// that URL and miss. Conditions wrap the imported rules (`@media` / `@layer` / `@supports`);
/// remote URLs stay as `@import`s, first. `resolve(dir, spec)` finds a file (relative paths and
/// packages); one it can't find stays as written. Each file is inlined once (cycles stop).
pub fn inline_imports(
    abs: &Path,
    css: &str,
    resolve: &dyn Fn(&Path, &str) -> Option<std::path::PathBuf>,
) -> String {
    inline_imports_with_files(abs, css, resolve).0
}

/// [`inline_imports`], plus the files it inlined (for cache invalidation).
pub fn inline_imports_with_files(
    abs: &Path,
    css: &str,
    resolve: &dyn Fn(&Path, &str) -> Option<std::path::PathBuf>,
) -> (String, Vec<std::path::PathBuf>) {
    let mut seen = std::collections::HashSet::new();
    seen.insert(abs.to_path_buf());
    let mut remote = Vec::new();
    let body = inline_rec(abs, css, resolve, &mut seen, &mut remote);
    let css = if remote.is_empty() {
        body
    } else {
        format!("{}\n{body}", remote.join("\n"))
    };
    seen.remove(abs);
    (css, seen.into_iter().collect())
}

fn inline_rec(
    abs: &Path,
    css: &str,
    resolve: &dyn Fn(&Path, &str) -> Option<std::path::PathBuf>,
    seen: &mut std::collections::HashSet<std::path::PathBuf>,
    remote: &mut Vec<String>,
) -> String {
    let dir = abs.parent().unwrap_or(Path::new("."));
    let mut out = String::new();
    let mut rest = css;
    loop {
        // Leading whitespace, comments, and @charset may precede imports.
        let trimmed = rest.trim_start();
        let skipped = &rest[..rest.len() - trimmed.len()];
        if trimmed.starts_with("/*") {
            let end = trimmed.find("*/").map(|i| i + 2).unwrap_or(trimmed.len());
            out.push_str(skipped);
            out.push_str(&trimmed[..end]);
            rest = &trimmed[end..];
            continue;
        }
        if trimmed.starts_with("@charset") {
            let end = trimmed.find(';').map(|i| i + 1).unwrap_or(trimmed.len());
            rest = &trimmed[end..]; // one @charset per output at most; UTF-8 is the default
            continue;
        }
        if !trimmed.starts_with("@import") {
            break;
        }
        let Some(end) = trimmed.find(';') else { break };
        let rule = &trimmed["@import".len()..end];
        rest = &trimmed[end + 1..];
        let (spec, cond) = parse_import(rule.trim());
        // Remote and root-relative URLs (a public/ file) are real URLs: they stay imports, first.
        if spec.starts_with("http://") || spec.starts_with("https://") || spec.starts_with('/') {
            remote.push(format!("@import{rule};"));
            continue;
        }
        let target = if spec.starts_with('.') {
            Some(dir.join(spec))
        } else {
            resolve(dir, spec).or_else(|| Some(dir.join(spec)))
        };
        let Some(target) = target.filter(|p| p.is_file()) else {
            out.push_str(&format!("@import{rule};"));
            continue;
        };
        let target = dunce::canonicalize(&target).unwrap_or(target);
        if !seen.insert(target.clone()) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&target) else {
            out.push_str(&format!("@import{rule};"));
            continue;
        };
        let inner = inline_rec(&target, &text, resolve, seen, remote);
        let cond = cond.trim();
        if cond.is_empty() {
            out.push_str(&inner);
        } else if let Some(layer) = cond.strip_prefix("layer") {
            let name = layer
                .trim()
                .trim_start_matches('(')
                .split(')')
                .next()
                .unwrap_or("")
                .trim();
            let media = layer.split_once(')').map(|(_, m)| m.trim()).unwrap_or("");
            let wrapped = format!("@layer {name} {{\n{inner}\n}}");
            out.push_str(&if media.is_empty() {
                wrapped
            } else {
                format!("@media {media} {{\n{wrapped}\n}}")
            });
        } else if let Some(sup) = cond.strip_prefix("supports") {
            out.push_str(&format!("@supports {} {{\n{inner}\n}}", sup.trim()));
        } else {
            out.push_str(&format!("@media {cond} {{\n{inner}\n}}"));
        }
        out.push('\n');
    }
    out.push_str(rest);
    out
}

/// Splits an `@import` rule's prelude into the specifier and its conditions:
/// `"x" screen` → ("x", " screen"), `url(x) layer(a)` → ("x", " layer(a)").
fn parse_import(rule: &str) -> (&str, &str) {
    let r = rule.trim();
    if let Some(inner) = r.strip_prefix("url(") {
        let close = inner.find(')').unwrap_or(inner.len());
        let spec = inner[..close].trim().trim_matches(['"', '\'']);
        return (spec, inner.get(close + 1..).unwrap_or(""));
    }
    let q = r.chars().next().unwrap_or('"');
    if q == '"' || q == '\'' {
        let body = &r[1..];
        let close = body.find(q).unwrap_or(body.len());
        return (&body[..close], body.get(close + 1..).unwrap_or(""));
    }
    let (spec, cond) = r.split_once(char::is_whitespace).unwrap_or((r, ""));
    (spec, cond)
}

/// An empty module, for a CSS import on the server whose file can't be read and for a relative
/// CSS `import()` (static imports of readable CSS get its text as the default export).
pub const CSS_NOOP_SPECIFIER: &str = "data:text/javascript,";

/// A JS string literal for `s`, also valid JSON (Rust's `{:?}` writes control characters as
/// `\u{1f}`, which JSON doesn't accept).
pub fn js_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Whether `path` is a stylesheet (`.css`, CSS Modules included).
pub fn is_css(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()) == Some("css")
}

/// CSS Modules (`*.module.css`): scopes local class names and exports a name map to JS.
pub fn is_css_module(path: &Path) -> bool {
    path.to_str().is_some_and(|s| s.ends_with(".module.css"))
}

/// Stable scope id for CSS Modules and plain CSS shims. Used as the input to [`scope_css`].
///
/// Shipped to the client (style `data-nowaki-css`, scoped class suffix). Root-relative paths
/// avoid leaking absolute paths; files outside the app root (pnpm store etc.) hash stably.
/// Dev SSR, the dev server (`serve_file` in the CLI), and the production build must all use this
/// function.
pub fn css_scope_id(root: &Path, abs: &Path) -> String {
    match abs.strip_prefix(root) {
        Ok(rel) => rel.to_string_lossy().replace('\\', "/"),
        Err(_) => format!("ext/{:016x}", xxh3_64(abs.to_string_lossy().as_bytes())),
    }
}

/// Scopes class selectors `.name` to `.name_<suffix>`; returns (scoped CSS, original→new names).
/// The suffix derives from `id`, so it is stable (matches across dev and build, client and SSR).
/// A simple scanner, not a full CSS parser.
pub fn scope_css(id: &str, css: &str) -> (String, Vec<(String, String)>) {
    let suffix = format!("{:08x}", xxh3_64(id.as_bytes()) as u32);
    let bytes = css.as_bytes();
    let mut out = String::with_capacity(css.len() + 64);
    let mut map: Vec<(String, String)> = Vec::new();
    // Bytes in `css[copied..i]` are copied through unchanged as one slice. Every split point
    // sits on an ASCII byte ('.' or an ident char), so the slices stay on UTF-8 char
    // boundaries and non-ASCII text (comments, `content`, font names) is never re-encoded.
    let mut copied = 0;
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        // Comments, strings, `url(…)` and attribute selectors hold file names and text
        // (`url(/img/bg.png)`, `content: "a.b"`, `[href$=".pdf"]`), not class selectors.
        if c == b'/' && bytes.get(i + 1) == Some(&b'*') {
            i = css[i + 2..]
                .find("*/")
                .map_or(bytes.len(), |e| i + 2 + e + 2);
            continue;
        }
        if c == b'"' || c == b'\'' {
            i = skip_string(bytes, i);
            continue;
        }
        if c == b'[' {
            let mut j = i + 1;
            while j < bytes.len() && bytes[j] != b']' {
                j = if bytes[j] == b'"' || bytes[j] == b'\'' {
                    skip_string(bytes, j)
                } else {
                    j + 1
                };
            }
            i = (j + 1).min(bytes.len());
            continue;
        }
        if (c == b'u' || c == b'U')
            && bytes.len() >= i + 4
            && bytes[i..i + 4].eq_ignore_ascii_case(b"url(")
            && (i == 0 || !is_ident_char(bytes[i - 1]))
        {
            let mut j = i + 4;
            while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            // A quoted URL is skipped as a string by the next turn of the loop.
            i = if j < bytes.len() && (bytes[j] == b'"' || bytes[j] == b'\'') {
                j
            } else {
                css[j..].find(')').map_or(bytes.len(), |e| j + e + 1)
            };
            continue;
        }
        // Class selector start: '.' followed by an ident start (a letter, `_`, or `-`).
        if c == b'.' && i + 1 < bytes.len() && is_ident_start(bytes[i + 1]) {
            out.push_str(&css[copied..i]);
            let start = i + 1;
            let mut j = start;
            while j < bytes.len() && is_ident_char(bytes[j]) {
                j += 1;
            }
            let name = &css[start..j];
            let scoped = format!("{name}_{suffix}");
            out.push('.');
            out.push_str(&scoped);
            if !map.iter().any(|(k, _)| k == name) {
                map.push((name.to_string(), scoped));
            }
            i = j;
            copied = j;
            continue;
        }
        i += 1;
    }
    out.push_str(&css[copied..]);
    (out, map)
}

/// The index just past the string literal that opens at `start` (backslash escapes included).
fn skip_string(bytes: &[u8], start: usize) -> usize {
    let quote = bytes[start];
    let mut j = start + 1;
    while j < bytes.len() {
        match bytes[j] {
            b'\\' => j += 2,
            b if b == quote => return j + 1,
            _ => j += 1,
        }
    }
    bytes.len()
}

fn is_ident_start(b: u8) -> bool {
    b.is_ascii_alphabetic() || b == b'_' || b == b'-'
}
fn is_ident_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-'
}

/// Renders the original→scoped name map as a JS object literal.
pub fn mapping_object(map: &[(String, String)]) -> String {
    let fields: Vec<String> = map.iter().map(|(k, v)| format!("{k:?}:{v:?}")).collect();
    format!("{{{}}}", fields.join(","))
}

/// Client CSS Modules module: injects the scoped CSS via `<style>` and
/// default-exports the class name map.
pub fn css_module_client_js(style_id: &str, scoped_css: &str, map: &[(String, String)]) -> String {
    format!(
        "{}export default {};\n",
        css_shim_body(style_id, scoped_css),
        mapping_object(map)
    )
}

/// A CSS Module for SSR: no DOM, so no injection; exports only the class name map. (The SSR
/// transform and the server build inline the same module as a `data:` URL.)
pub fn css_module_mapping_js(map: &[(String, String)]) -> String {
    format!("export default {};\n", mapping_object(map))
}

/// Converts .css into the source of a JS module that injects a `<style>` (shared by dev and
/// build). Reuses the style with the same id, so the module never injects twice and a hot update
/// replaces the text. Copies the page's CSP nonce (`window.__nowakiNonce`, set by the client
/// runtime, or from a nonced script) so an enforced `style-src-elem` allows it.
pub fn css_shim(id: &str, css: &str) -> String {
    css_shim_body(id, css) + "export default __css;\n"
}

/// The injecting part of [`css_shim`], without an export (CSS Modules export their class map).
fn css_shim_body(id: &str, css: &str) -> String {
    let css_lit = js_string(css);
    let id_lit = js_string(id);
    format!(
        "const __css = {css_lit};\n\
const __id = {id_lit};\n\
let __el = document.querySelector('style[data-nowaki-css=' + JSON.stringify(__id) + ']');\n\
if (!__el) {{ __el = document.createElement('style'); __el.setAttribute('data-nowaki-css', __id); const __n = window.__nowakiNonce || document.querySelector('script[nonce]')?.nonce; if (__n) __el.nonce = __n; document.head.appendChild(__el); }}\n\
__el.textContent = __css;\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_string_escapes_for_javascript() {
        assert_eq!(js_string("a\"b\\c"), r#""a\"b\\c""#);
        assert_eq!(js_string("x\ny\u{1f}z"), r#""x\ny\u001fz""#);
        assert_eq!(js_string("\u{e9} \u{2028}"), "\"\u{e9} \\u2028\"");
    }

    #[test]
    fn detects_css_and_modules() {
        assert!(is_css(Path::new("a.css")));
        assert!(!is_css(Path::new("a.ts")));
        assert!(is_css_module(Path::new("Badge.module.css")));
        assert!(!is_css_module(Path::new("global.css")));
    }

    #[test]
    fn css_scope_id_root_relative_and_out_of_root() {
        let root = Path::new("/app");
        assert_eq!(
            css_scope_id(root, Path::new("/app/islands/Badge.module.css")),
            "islands/Badge.module.css"
        );
        let ext = css_scope_id(root, Path::new("/pnpm/store/pkg/Badge.module.css"));
        assert!(ext.starts_with("ext/"));
        assert_eq!(ext.len(), "ext/".len() + 16);
    }

    #[test]
    fn css_scope_id_rejects_absolute_path_as_scope_id() {
        let root = Path::new("/proj/hello");
        let abs = Path::new("/proj/hello/islands/Badge.module.css");
        let css = ".badge { color: red }";
        let id = css_scope_id(root, abs);
        let (_, from_root_relative) = scope_css(&id, css);
        let (_, from_absolute) = scope_css(&abs.to_string_lossy(), css);
        assert_ne!(
            from_root_relative[0].1, from_absolute[0].1,
            "absolute path must not be used as scope id when root-relative id exists"
        );
    }

    /// Dev SSR, dev CSS serving, and build emit must pass the same id into `scope_css`.
    #[test]
    fn css_scope_id_same_for_all_call_sites() {
        let root = Path::new("/proj/hello");
        let abs = Path::new("/proj/hello/islands/Badge.module.css");
        let css = ".badge { color: red } .badge:hover { color: white }";
        let id = css_scope_id(root, abs);
        let (_, map) = scope_css(&id, css);
        let (_, again) = scope_css(&css_scope_id(root, abs), css);
        assert_eq!(map, again);
        assert_eq!(map[0].0, "badge");
        assert_eq!(map[0].1.len(), "badge".len() + 1 + 8);
    }

    #[test]
    fn scope_css_scopes_classes_and_keeps_values() {
        let css = ".badge { color: red } .badge-x { padding: 0.5rem }";
        let (scoped, map) = scope_css("/app/Badge.module.css", css);
        assert!(scoped.contains(".badge_"));
        assert!(scoped.contains(".badge-x_"));
        // Dots with digits inside values (0.5rem) are not mistaken for classes.
        assert!(scoped.contains("0.5rem"));
        assert_eq!(map.len(), 2);
        assert_eq!(map[0].0, "badge");
        assert!(map[0].1.starts_with("badge_"));
        assert_eq!(map[0].1.len(), "badge".len() + 1 + 8); // name_ + 8 hex
    }

    #[test]
    fn scope_css_keeps_non_ascii_text_intact() {
        let css = "/* \u{898b}\u{51fa}\u{3057} */\n.t { font-family: \"\u{6e38}\u{30b4}\u{30b7}\u{30c3}\u{30af}\"; }\n.t::before { content: \"\u{2192} \u{1f389}\"; }\n.\u{e9} { color: red }";
        let (scoped, map) = scope_css("routes/jp/jp.module.css", css);
        let suffix = &map[0].1["t_".len()..];
        assert_eq!(
            scoped,
            format!(
                "/* \u{898b}\u{51fa}\u{3057} */\n.t_{suffix} {{ font-family: \"\u{6e38}\u{30b4}\u{30b7}\u{30c3}\u{30af}\"; }}\n.t_{suffix}::before {{ content: \"\u{2192} \u{1f389}\"; }}\n.\u{e9} {{ color: red }}"
            )
        );
        assert_eq!(map.len(), 1);
    }

    #[test]
    fn scope_css_is_deterministic_and_id_scoped() {
        let css = ".x { color: blue }";
        let (a, _) = scope_css("id-a", css);
        let (a2, _) = scope_css("id-a", css);
        assert_eq!(
            a, a2,
            "same id+css must be stable (match across dev/build/SSR)"
        );
        let (_, mb) = scope_css("id-b", css);
        let (_, ma) = scope_css("id-a", css);
        assert_ne!(
            ma[0].1, mb[0].1,
            "different id \u{2192} different scoped name"
        );
    }

    #[test]
    fn mapping_object_and_shim() {
        assert_eq!(
            mapping_object(&[("a".into(), "a_1".into()), ("b".into(), "b_1".into())]),
            r#"{"a":"a_1","b":"b_1"}"#
        );
        let shim = css_shim("/app/x.css", ".x{color:red}");
        assert!(shim.contains("data-nowaki-css"));
        assert!(shim.contains("color:red"));
        assert!(shim.contains("/app/x.css"));
    }

    #[test]
    fn inlines_imports_with_conditions_and_keeps_remote_ones_first() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        std::fs::write(d.join("tokens.css"), ":root { --a: 1; }\n").unwrap();
        std::fs::write(
            d.join("print.css"),
            "@import './tokens.css';\nbody { color: black; }\n",
        )
        .unwrap();
        std::fs::create_dir_all(d.join("node_modules/pkg")).unwrap();
        std::fs::write(d.join("node_modules/pkg/x.css"), ".x { top: 0; }\n").unwrap();
        let main = d.join("base.css");
        let src = "/* hi */\n@import \"./tokens.css\";\n@import url(./print.css) print;\n@import \"pkg/x.css\" layer(vendor);\n@import url(\"https://fonts.example/a.css\");\n@import \"/public.css\";\n@import \"./missing.css\";\nbody { margin: 0; }\n";
        let resolve =
            |_: &Path, spec: &str| (spec == "pkg/x.css").then(|| d.join("node_modules/pkg/x.css"));
        let out = inline_imports(&main, src, &resolve);
        assert!(
            out.starts_with(
                "@import url(\"https://fonts.example/a.css\");\n@import \"/public.css\";\n"
            ),
            "{out}"
        );
        assert!(out.contains(":root { --a: 1; }"), "{out}");
        assert_eq!(
            out.matches("--a: 1").count(),
            1,
            "tokens.css is inlined once: {out}"
        );
        assert!(out.contains("@media print {\n"), "{out}");
        assert!(out.contains("@layer vendor {\n.x { top: 0; }"), "{out}");
        assert!(out.contains("@import \"./missing.css\";"), "{out}");
        assert!(out.trim_end().ends_with("body { margin: 0; }"), "{out}");
    }

    /// Only class selectors are scoped: `.ext` in URLs, strings, attribute selectors and
    /// comments stays as written.
    #[test]
    fn scope_css_leaves_urls_strings_attributes_and_comments_alone() {
        let css = "/* see a.b */\n.hero { background: url(/img/bg.png); }\n.q { background: URL( \"/img/q.jpg\" ); }\n@font-face { src: url('/fonts/x.woff2') format(\"woff2\"); }\n.t::after { content: \"a.b\\\".c\"; }\na[href$=\".pdf\"].doc, a[data-x='y.z'] { color: red }\n.last { color: blue }";
        let (scoped, map) = scope_css("routes/a.module.css", css);
        let names: Vec<&str> = map.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(names, ["hero", "q", "t", "doc", "last"], "{scoped}");
        let s = &map[0].1["hero_".len()..];
        for kept in [
            "/* see a.b */",
            "url(/img/bg.png)",
            "URL( \"/img/q.jpg\" )",
            "url('/fonts/x.woff2')",
            "content: \"a.b\\\".c\"",
            "[href$=\".pdf\"]",
            "[data-x='y.z']",
        ] {
            assert!(scoped.contains(kept), "{kept} changed:\n{scoped}");
        }
        assert!(scoped.contains(&format!(".doc_{s},")), "{scoped}");
        assert!(scoped.contains(&format!(".last_{s} ")), "{scoped}");
    }
}
