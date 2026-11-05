//! Build-time code highlighting for Markdown entries and MDX: syntect through comrak's adapter,
//! as inline `style` colors (no CSS or client JS; CSP allows style attributes). The syntax and
//! theme sets load once per process. Pure-Rust regexes (no Oniguruma C library). Syntaxes come
//! from two-face (bat's set): syntect's defaults have no TypeScript / TSX, Vue, or TOML.

//!
//! Highlighted output is cached on disk (`node_modules/.cache/nowaki/highlight`), keyed by the
//! language, the code, the theme, and the nowaki version: compiling a large grammar (TypeScript
//! takes ~150 ms) happens once, not on every build or dev reload.

use std::borrow::Cow;
use std::collections::HashMap;
use std::fmt;
use std::path::PathBuf;
use std::sync::OnceLock;

use comrak::adapters::SyntaxHighlighterAdapter;
use comrak::plugins::syntect::{SyntectAdapter, SyntectAdapterBuilder};
use xxhash_rust::xxh3::xxh3_64;

pub const CODE_THEME: &str = "InspiredGitHub";

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
            let h = xxh3_64(format!("{}|{CODE_THEME}|{key}", env!("CARGO_PKG_VERSION")).as_bytes());
            d.join(format!("{h:016x}.html"))
        });
        if let Some(hit) = file.as_ref().and_then(|f| std::fs::read_to_string(f).ok()) {
            return output.write_str(&hit);
        }
        let mut s = String::new();
        make(&mut s)?;
        if let Some(f) = file {
            let _ = std::fs::write(f, &s); // a miss next time is the only cost
        }
        output.write_str(&s)
    }
}

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
}
