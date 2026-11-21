//! Build-time code highlighting for Markdown entries and MDX: syntect through comrak's adapter,
//! as inline `style` colors (no CSS or client JS; CSP allows style attributes). The syntax and
//! theme sets load once per process. Pure-Rust regexes (no Oniguruma C library). Syntaxes come
//! from two-face (bat's set): syntect's defaults have no TypeScript / TSX, Vue, or TOML.
//!
//! Colors follow the page's color scheme: each inline color is written twice, the light one
//! (`color:#323232;`), then `color:light-dark(#323232,#c9d1d9);` with its GitHub-dark counterpart
//! ([`dark_color`]). A page with `color-scheme: dark` (or `light dark` and a dark OS) gets the
//! dark colors; a page that sets no `color-scheme`, and a browser without `light-dark()` (which
//! drops that declaration), keeps the light ones.
//!
//! Highlighted output is cached on disk (`node_modules/.cache/nowaki/highlight`), keyed by the
//! language, the code, the theme, and the nowaki-core version: compiling a large grammar
//! (TypeScript takes ~150 ms) happens once, not on every build or dev reload.

use std::borrow::Cow;
use std::collections::HashMap;
use std::fmt;
use std::path::PathBuf;
use std::sync::OnceLock;

use comrak::adapters::SyntaxHighlighterAdapter;
use comrak::plugins::syntect::{SyntectAdapter, SyntectAdapterBuilder};
use xxhash_rust::xxh3::xxh3_64;

/// The syntect theme code blocks are colored with (light; [`dark_color`] maps it to dark).
pub const CODE_THEME: &str = "InspiredGitHub";

/// Every color of [`CODE_THEME`] and its GitHub-dark (Primer) counterpart, the second value of
/// `light-dark()`. The dark style of a token is its light style with the colors mapped, so span
/// boundaries stay as they were.
const DARK_PALETTE: &[(&str, &str)] = &[
    ("ffffff", "0d1117"), // background
    ("323232", "c9d1d9"), // text, variables
    ("969896", "8b949e"), // comments
    ("183691", "a5d6ff"), // strings
    ("a71d5d", "ff7b72"), // keywords, storage
    ("0086b3", "79c0ff"), // constants, types
    ("795da3", "d2a8ff"), // functions, attribute names
    ("63a35c", "7ee787"), // tags
    ("62a35c", "7ee787"), // support functions
    ("ed6a43", "ffa657"), // `this`, CSS colors
    ("b52a1d", "ffa198"), // invalid
    ("f5f5f5", "161b22"), // invalid background
    ("b3b3b3", "6e7681"), // line numbers
    ("bd2c00", "ffa198"), // deleted
    ("ffecec", "490202"), // deleted background
    ("55a532", "7ee787"), // inserted
    ("eaffea", "04260f"), // inserted background
    ("4183c4", "58a6ff"), // links
];

/// The dark counterpart of a light theme color (`rrggbb` or `rrggbbaa`, lowercase hex as syntect
/// writes it; the alpha is kept). None for a color the theme doesn't use.
pub fn dark_color(light: &str) -> Option<String> {
    let (rgb, alpha) = light.split_at(light.len().min(6));
    DARK_PALETTE
        .iter()
        .find(|(l, _)| *l == rgb)
        .map(|(_, d)| format!("{d}{alpha}"))
}

/// Adds `<prop>:light-dark(<light>,<dark>);` after each `color:` / `background-color:` declaration
/// in the `style="…"` attributes of syntect's HTML. Highlighted text is escaped (`"` is
/// `&quot;`), so ` style="` only ever starts an attribute.
fn with_dark_colors(html: &str) -> String {
    const ATTR: &str = " style=\"";
    let mut out = String::with_capacity(html.len() * 2);
    let mut rest = html;
    while let Some(i) = rest.find(ATTR) {
        let start = i + ATTR.len();
        let Some(len) = rest[start..].find('"') else {
            break;
        };
        out.push_str(&rest[..start]);
        for decl in rest[start..start + len].split_inclusive(';') {
            out.push_str(decl);
            let pair = decl.strip_suffix(';').and_then(|d| d.split_once(":#"));
            if let Some((prop, light)) = pair {
                if prop == "color" || prop == "background-color" {
                    if let Some(dark) = dark_color(light) {
                        out.push_str(&format!("{prop}:light-dark(#{light},#{dark});"));
                    }
                }
            }
        }
        rest = &rest[start + len..];
    }
    out.push_str(rest);
    out
}

static CACHE_DIR: OnceLock<Option<PathBuf>> = OnceLock::new();

/// Where highlighted blocks are cached; `NowakiCore::new` sets it for the app (first one wins).
pub fn set_cache_root(root: &std::path::Path) {
    CACHE_DIR.get_or_init(|| {
        let dir = root.join("node_modules/.cache/nowaki/highlight");
        std::fs::create_dir_all(&dir).ok().map(|_| dir)
    });
}

/// The shared adapter (comrak's `codefence_syntax_highlighter`): syntect behind the disk cache.
/// The syntax set loads only on the first cache miss.
pub fn adapter() -> &'static CachedAdapter {
    static ADAPTER: CachedAdapter = CachedAdapter {
        inner: OnceLock::new(),
    };
    &ADAPTER
}

/// A [`SyntaxHighlighterAdapter`] that wraps syntect's with the disk cache (see [`adapter`]).
pub struct CachedAdapter {
    inner: OnceLock<SyntectAdapter>,
}

impl CachedAdapter {
    fn syntect(&self) -> &SyntectAdapter {
        self.inner.get_or_init(|| {
            SyntectAdapterBuilder::new()
                .syntax_set(two_face::syntax::extra_newlines())
                .theme(CODE_THEME)
                .build()
        })
    }

    /// The cached output for `key`, or `make`'s (then stored).
    fn cached(
        &self,
        output: &mut dyn fmt::Write,
        key: &str,
        make: impl FnOnce(&mut String) -> fmt::Result,
    ) -> fmt::Result {
        let file = CACHE_DIR.get().and_then(|d| d.as_ref()).map(|d| {
            let h = xxh3_64(
                format!(
                    "{}|{CODE_THEME}|light-dark|{key}",
                    env!("CARGO_PKG_VERSION")
                )
                .as_bytes(),
            );
            d.join(format!("{h:016x}.html"))
        });
        if let Some(hit) = file.as_ref().and_then(|f| std::fs::read_to_string(f).ok()) {
            return output.write_str(&hit);
        }
        let mut s = String::new();
        make(&mut s)?;
        let s = with_dark_colors(&s);
        if let Some(f) = file {
            let _ = std::fs::write(f, &s); // a miss next time is the only cost
        }
        output.write_str(&s)
    }
}

/// A cache key part for tag attributes, independent of the map's order.
fn attrs_key(attributes: &HashMap<&'static str, Cow<'_, str>>) -> String {
    let mut pairs: Vec<String> = attributes.iter().map(|(k, v)| format!("{k}={v}")).collect();
    pairs.sort();
    pairs.join("\u{1f}")
}

impl SyntaxHighlighterAdapter for CachedAdapter {
    fn write_highlighted(
        &self,
        output: &mut dyn fmt::Write,
        lang: Option<&str>,
        code: &str,
    ) -> fmt::Result {
        let key = format!("code|{}|{code}", lang.unwrap_or(""));
        self.cached(output, &key, |s| {
            self.syntect().write_highlighted(s, lang, code)
        })
    }

    fn write_pre_tag(
        &self,
        output: &mut dyn fmt::Write,
        attributes: HashMap<&'static str, Cow<'_, str>>,
    ) -> fmt::Result {
        let key = format!("pre|{}", attrs_key(&attributes));
        self.cached(output, &key, |s| {
            self.syntect().write_pre_tag(s, attributes)
        })
    }

    fn write_code_tag(
        &self,
        output: &mut dyn fmt::Write,
        attributes: HashMap<&'static str, Cow<'_, str>>,
    ) -> fmt::Result {
        let key = format!("code-tag|{}", attrs_key(&attributes));
        self.cached(output, &key, |s| {
            self.syntect().write_code_tag(s, attributes)
        })
    }
}

/// A fenced code block as HTML, exactly as a Markdown entry renders it: `<pre style=…><code
/// class="language-x">…</code></pre>` with highlighting when the language is known.
pub fn code_block_html(lang: &str, code: &str) -> String {
    let fence = "`".repeat(longest_backtick_run(code).max(2) + 1);
    let md = format!("{fence}{lang}\n{code}\n{fence}\n");
    let arena = comrak::Arena::new();
    let options = comrak::Options::default();
    let doc = comrak::parse_document(&arena, &md, &options);
    let mut plugins = comrak::options::Plugins::default();
    if !lang.is_empty() {
        plugins.render.codefence_syntax_highlighter = Some(adapter());
    }
    let mut html = String::new();
    comrak::format_html_with_plugins(doc, &options, &mut html, &plugins)
        .expect("writing to a String");
    html
}

fn longest_backtick_run(s: &str) -> usize {
    let mut best = 0;
    let mut run = 0;
    for c in s.chars() {
        if c == '`' {
            run += 1;
            best = best.max(run);
        } else {
            run = 0;
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn highlights_a_known_language_and_escapes_the_rest() {
        let rust = code_block_html("rust", "fn main() {}");
        assert!(rust.starts_with("<pre style="), "{rust}");
        assert!(rust.contains("<span"), "{rust}");
        let plain = code_block_html("", "a < b ``` c");
        assert!(plain.contains("a &lt; b ``` c"), "{plain}");
    }

    /// The output before colors followed the color scheme: comrak's syntect adapter alone.
    fn light_only(lang: &str, code: &str) -> String {
        let adapter = SyntectAdapterBuilder::new()
            .syntax_set(two_face::syntax::extra_newlines())
            .theme(CODE_THEME)
            .build();
        let fence = "`".repeat(longest_backtick_run(code).max(2) + 1);
        let md = format!("{fence}{lang}\n{code}\n{fence}\n");
        let arena = comrak::Arena::new();
        let options = comrak::Options::default();
        let doc = comrak::parse_document(&arena, &md, &options);
        let mut plugins = comrak::options::Plugins::default();
        plugins.render.codefence_syntax_highlighter = Some(&adapter);
        let mut html = String::new();
        comrak::format_html_with_plugins(doc, &options, &mut html, &plugins).unwrap();
        html
    }

    /// `html` without the `light-dark()` declarations.
    fn strip_dark(html: &str) -> String {
        let mut out = html.to_string();
        for prop in ["background-color", "color"] {
            let open = format!(";{prop}:light-dark(");
            while let Some(i) = out.find(&open) {
                let end = i + out[i..].find(");").unwrap() + 1;
                out.replace_range(i + 1..end + 1, "");
            }
        }
        out
    }

    #[test]
    fn light_output_is_unchanged() {
        let samples = [
            (
                "rust",
                "fn main() {\n    let x: u8 = 1; // one\n    println!(\"{x}\");\n}",
            ),
            (
                "ts",
                "export const head = \"<style>a{}</style>\";\nconst n = 0x1f;\nthis.x = /re/g;",
            ),
            (
                "tsx",
                "export default function Page() {\n  return <a href=\"/\">hi</a>;\n}",
            ),
            ("json", "{\"a\": [1, true, null, \"s\"]}"),
            ("css", ":root { color: #fff; } a:hover { margin: 0 }"),
            ("diff", "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new"),
            ("html", "<p class=\"x\">a &amp; b</p>"),
            ("nosuchlang", "plain <text> \"quoted\""),
        ];
        for (lang, code) in samples {
            let html = code_block_html(lang, code);
            assert_eq!(strip_dark(&html), light_only(lang, code), "{lang}");
            assert!(html.contains("light-dark("), "{lang}: {html}");
        }
    }

    #[test]
    fn colors_follow_the_color_scheme() {
        let rust = code_block_html("rust", "fn main() {}");
        assert!(
            rust.starts_with(
                "<pre style=\"background-color:#ffffff;background-color:light-dark(#ffffff,#0d1117);\">"
            ),
            "{rust}"
        );
        // The light color first, for browsers without light-dark().
        assert!(
            rust.contains("color:#a71d5d;color:light-dark(#a71d5d,#ff7b72);\">fn </span>"),
            "{rust}"
        );
        assert_eq!(dark_color("323232").as_deref(), Some("c9d1d9"));
        assert_eq!(dark_color("323232cc").as_deref(), Some("c9d1d9cc"));
        assert_eq!(dark_color("123456"), None);
        // Text that looks like a style attribute is escaped, so it's left alone.
        let text = code_block_html("txt", "<b style=\"color:#323232;\">");
        assert!(
            text.contains("&lt;b style=&quot;color:#323232;&quot;&gt;"),
            "{text}"
        );
        assert_eq!(text.matches("light-dark(").count(), 2, "{text}");
    }

    #[test]
    fn every_theme_color_has_a_dark_counterpart() {
        let themes = syntect::highlighting::ThemeSet::load_defaults();
        let theme = &themes.themes[CODE_THEME];
        let hex = |c: syntect::highlighting::Color| format!("{:02x}{:02x}{:02x}", c.r, c.g, c.b);
        let mut colors = vec![
            theme.settings.background.unwrap(),
            theme.settings.foreground.unwrap(),
        ];
        for item in &theme.scopes {
            colors.extend(item.style.foreground);
            colors.extend(item.style.background);
        }
        let mut missing: Vec<String> = colors
            .into_iter()
            .map(hex)
            .filter(|c| dark_color(c).is_none())
            .collect();
        missing.sort();
        missing.dedup();
        assert!(missing.is_empty(), "no dark color for {missing:?}");
    }
}
