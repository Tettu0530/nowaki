//! Build-time code highlighting for Markdown entries and MDX: syntect through comrak's adapter,
//! as inline `style` colors (no CSS or client JS; CSP allows style attributes). The syntax and
//! theme sets load once per process. Pure-Rust regexes (no Oniguruma C library). Syntaxes come
//! from two-face (bat's set): syntect's defaults have no TypeScript / TSX, Vue, or TOML.

use comrak::plugins::syntect::{SyntectAdapter, SyntectAdapterBuilder};

pub const CODE_THEME: &str = "InspiredGitHub";

/// The shared adapter (comrak's `codefence_syntax_highlighter`).
pub fn adapter() -> &'static SyntectAdapter {
    static ADAPTER: std::sync::OnceLock<SyntectAdapter> = std::sync::OnceLock::new();
    ADAPTER.get_or_init(|| {
        SyntectAdapterBuilder::new()
            .syntax_set(two_face::syntax::extra_newlines())
            .theme(CODE_THEME)
            .build()
    })
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
