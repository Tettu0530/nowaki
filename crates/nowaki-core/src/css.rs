use std::path::Path;

use xxhash_rust::xxh3::xxh3_64;

/// Empty module that neutralizes .css imports on the server (CSS is client-only).
pub const CSS_NOOP_SPECIFIER: &str = "data:text/javascript,";

pub fn is_css(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()) == Some("css")
}

/// CSS Modules (`*.module.css`): scopes local class names and exports a name map to JS.
pub fn is_css_module(path: &Path) -> bool {
    path.to_str().is_some_and(|s| s.ends_with(".module.css"))
}

/// Scopes class selectors `.name` to `.name_<suffix>`; returns (scoped CSS, original→new names).
/// The suffix derives from id, so it is stable (matches across dev/build and client/SSR). A simple scanner, not a full CSS parser.
pub fn scope_css(id: &str, css: &str) -> (String, Vec<(String, String)>) {
    let suffix = format!("{:08x}", xxh3_64(id.as_bytes()) as u32);
    let bytes = css.as_bytes();
    let mut out = String::with_capacity(css.len() + 64);
    let mut map: Vec<(String, String)> = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        // Class selector start: '.' followed by an ident-start (a-zA-Z_ or -<letter>)
        if c == b'.' && i + 1 < bytes.len() && is_ident_start(bytes[i + 1]) {
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
            continue;
        }
        out.push(c as char);
        i += 1;
    }
    (out, map)
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
        css_shim(style_id, scoped_css),
        mapping_object(map)
    )
}

/// For SSR / server builds: no DOM, so no injection; exports only the class name map.
pub fn css_module_mapping_js(map: &[(String, String)]) -> String {
    format!("export default {};\n", mapping_object(map))
}

/// Converts .css into the source of a JS module that injects a <style> (shared by dev/build).
/// Reuses the style with the same id (avoids duplicate injection and HMR re-injection).
pub fn css_shim(id: &str, css: &str) -> String {
    let css_lit = format!("{css:?}");
    let id_lit = format!("{id:?}");
    format!(
        "const __css = {css_lit};\n\
const __id = {id_lit};\n\
let __el = document.querySelector('style[data-nowaki-css=' + JSON.stringify(__id) + ']');\n\
if (!__el) {{ __el = document.createElement('style'); __el.setAttribute('data-nowaki-css', __id); document.head.appendChild(__el); }}\n\
__el.textContent = __css;\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_css_and_modules() {
        assert!(is_css(Path::new("a.css")));
        assert!(!is_css(Path::new("a.ts")));
        assert!(is_css_module(Path::new("Badge.module.css")));
        assert!(!is_css_module(Path::new("global.css")));
    }

    #[test]
    fn scope_css_scopes_classes_and_keeps_values() {
        let css = ".badge { color: red } .badge-x { padding: 0.5rem }";
        let (scoped, map) = scope_css("/app/Badge.module.css", css);
        assert!(scoped.contains(".badge_"));
        assert!(scoped.contains(".badge-x_"));
        // Dots with digits inside values (0.5rem) are not mistaken for classes
        assert!(scoped.contains("0.5rem"));
        assert_eq!(map.len(), 2);
        assert_eq!(map[0].0, "badge");
        assert!(map[0].1.starts_with("badge_"));
        assert_eq!(map[0].1.len(), "badge".len() + 1 + 8); // name_ + 8 hex
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
        assert_ne!(ma[0].1, mb[0].1, "different id → different scoped name");
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
}
