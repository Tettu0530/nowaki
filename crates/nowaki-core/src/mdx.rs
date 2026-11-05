//! MDX: `.mdx` files become TSX modules before anything else sees them (`NowakiCore::read_source`
//! calls `to_tsx`), so routes, islands, the import graph, dev, and the builds treat them like
//! `.tsx`. Parsing is markdown-rs (CommonMark + GFM + MDX: ESM, JSX, `{expressions}`,
//! frontmatter); no JavaScript runs.
//!
//! The module:
//!
//! ```text
//! <the file's import / export lines, as written>
//! import __nowakiImage0 from "./hero.jpg?image";          // local images, through ?image
//! export const headings = [{ depth, text, id }, …];
//! export default function MDXContent(props) { return <>…</>; }
//! ```
//!
//! - Markdown becomes plain JSX elements (`<h2 id="…">`, `<p>`, `<table>`, …). Heading ids match
//!   a Markdown entry's (comrak's anchorizer), and so does the `headings` list.
//! - Fenced code is highlighted at build time exactly like Markdown (`highlight.rs`).
//! - Local images (`![alt](./hero.jpg)`) go through `?image` and `<Image>`; root-relative and
//!   remote ones stay `<img>`.
//! - JSX elements and expressions are passed through, so imported components and islands
//!   (`<Counter client:visible />`) work as in TSX.
//! - YAML frontmatter is skipped here; content collections read it in Rust (`content.rs`).

use std::fmt::Write;

use anyhow::{anyhow, Result};
use markdown::mdast::{AlignKind, AttributeContent, AttributeValue, Node};
use markdown::{Constructs, ParseOptions};

/// One heading, for a table of contents.
#[derive(Debug, Clone, PartialEq)]
pub struct Heading {
    pub depth: u8,
    pub text: String,
    pub id: String,
}

fn parse(source: &str) -> Result<Node> {
    let options = ParseOptions {
        constructs: Constructs {
            frontmatter: true,
            gfm_autolink_literal: true,
            gfm_footnote_definition: true,
            gfm_label_start_footnote: true,
            gfm_strikethrough: true,
            gfm_table: true,
            gfm_task_list_item: true,
            ..Constructs::mdx()
        },
        // ESM is validated by oxc afterwards (with the whole module), so accept each block here.
        mdx_esm_parse: Some(Box::new(|_| markdown::MdxSignal::Ok)),
        ..ParseOptions::default()
    };
    markdown::to_mdast(source, &options).map_err(|m| anyhow!("MDX: {m}"))
}

/// The headings of an MDX source, with the ids `to_tsx` gives them.
pub fn headings(source: &str) -> Result<Vec<Heading>> {
    let root = parse(source)?;
    let mut gen = Gen::default();
    gen.collect_headings(&root);
    Ok(gen.headings)
}

/// TSX for an MDX source (see the module docs).
pub fn to_tsx(source: &str) -> Result<String> {
    let root = parse(source)?;
    let mut gen = Gen::default();
    gen.collect_headings(&root);
    let Node::Root(r) = &root else {
        return Err(anyhow!("MDX: no root"));
    };
    let mut esm = String::new();
    let mut body = String::new();
    for child in &r.children {
        match child {
            Node::MdxjsEsm(e) => {
                esm.push_str(&e.value);
                esm.push('\n');
            }
            Node::Yaml(_) | Node::Toml(_) => {}
            other => gen.node(other, &mut body),
        }
    }
    let mut out = String::new();
    out.push_str("// Generated from MDX by nowaki.\n");
    out.push_str(&esm);
    if !gen.images.is_empty() {
        out.push_str("import { Image as __NowakiImage } from \"@nowaki-dev/runtime/image\";\n");
        for (i, url) in gen.images.iter().enumerate() {
            let _ = writeln!(
                out,
                "import __nowakiImage{i} from {};",
                js_string(&format!("{url}?image"))
            );
        }
    }
    let heads: Vec<String> = gen
        .headings
        .iter()
        .map(|h| {
            format!(
                "{{ depth: {}, text: {}, id: {} }}",
                h.depth,
                js_string(&h.text),
                js_string(&h.id)
            )
        })
        .collect();
    let _ = writeln!(out, "export const headings = [{}];", heads.join(", "));
    let _ = write!(
        out,
        "export default function MDXContent(props) {{\n  return (\n    <>\n{body}\n    </>\n  );\n}}\n"
    );
    Ok(out)
}

#[derive(Default)]
struct Gen {
    headings: Vec<Heading>,
    /// Heading ids in document order, handed out again while generating.
    next_heading: usize,
    /// Local image URLs, imported with `?image` (index = import name).
    images: Vec<String>,
}

impl Gen {
    fn collect_headings(&mut self, root: &Node) {
        let mut anchorizer = comrak::Anchorizer::new();
        let mut stack = vec![root];
        let mut order = Vec::new();
        // Depth-first, document order.
        while let Some(n) = stack.pop() {
            if let Node::Heading(h) = n {
                order.push((h.depth, plain_text(n)));
                continue;
            }
            if let Some(children) = n.children() {
                for c in children.iter().rev() {
                    stack.push(c);
                }
            }
        }
        self.headings = order
            .into_iter()
            .map(|(depth, text)| Heading {
                depth,
                id: anchorizer.anchorize(&text),
                text,
            })
            .collect();
    }

    fn children(&mut self, nodes: &[Node], out: &mut String) {
        for n in nodes {
            self.node(n, out);
        }
    }

    fn wrap(&mut self, tag: &str, attrs: &str, nodes: &[Node], out: &mut String) {
        let _ = write!(out, "<{tag}{attrs}>");
        self.children(nodes, out);
        let _ = write!(out, "</{tag}>");
    }

    fn node(&mut self, node: &Node, out: &mut String) {
        match node {
            Node::Root(r) => self.children(&r.children, out),
            Node::Paragraph(p) => {
                // A paragraph holding only JSX / expressions (`<Counter />` on its own line in
                // some editors' output) stays a paragraph, as in MDX.
                self.wrap("p", "", &p.children, out);
                out.push('\n');
            }
            Node::Heading(h) => {
                let id = self
                    .headings
                    .get(self.next_heading)
                    .map(|x| x.id.clone())
                    .unwrap_or_default();
                self.next_heading += 1;
                let tag = format!("h{}", h.depth.clamp(1, 6));
                self.wrap(&tag, &format!(" id={}", js_attr(&id)), &h.children, out);
                out.push('\n');
            }
            Node::Text(t) => text(&t.value, out),
            Node::Emphasis(e) => self.wrap("em", "", &e.children, out),
            Node::Strong(s) => self.wrap("strong", "", &s.children, out),
            Node::Delete(d) => self.wrap("del", "", &d.children, out),
            Node::InlineCode(c) => {
                out.push_str("<code>");
                text(&c.value, out);
                out.push_str("</code>");
            }
            Node::Break(_) => out.push_str("<br />"),
            Node::ThematicBreak(_) => out.push_str("<hr />\n"),
            Node::Blockquote(b) => {
                self.wrap("blockquote", "", &b.children, out);
                out.push('\n');
            }
            Node::List(l) => {
                let tag = if l.ordered { "ol" } else { "ul" };
                let attrs = match (l.ordered, l.start) {
                    (true, Some(s)) if s != 1 => format!(" start={{{s}}}"),
                    _ => String::new(),
                };
                let _ = writeln!(out, "<{tag}{attrs}>");
                for item in &l.children {
                    if let Node::ListItem(li) = item {
                        out.push_str("<li>");
                        if let Some(checked) = li.checked {
                            let _ = write!(
                                out,
                                "<input type=\"checkbox\" disabled{} /> ",
                                if checked { " checked" } else { "" }
                            );
                        }
                        // Tight lists render their paragraphs inline, as Markdown does.
                        for c in &li.children {
                            match c {
                                Node::Paragraph(p) if !l.spread && !li.spread => {
                                    self.children(&p.children, out)
                                }
                                other => self.node(other, out),
                            }
                        }
                        out.push_str("</li>\n");
                    }
                }
                let _ = writeln!(out, "</{tag}>");
            }
            Node::Code(c) => {
                let html =
                    crate::highlight::code_block_html(c.lang.as_deref().unwrap_or(""), &c.value);
                raw_element(&html, out);
                out.push('\n');
            }
            Node::Link(l) => {
                let mut attrs = format!(" href={}", js_attr(&l.url));
                if let Some(t) = &l.title {
                    let _ = write!(attrs, " title={}", js_attr(t));
                }
                self.wrap("a", &attrs, &l.children, out);
            }
            Node::Image(i) => {
                if is_local(&i.url) {
                    let idx = self.images.len();
                    self.images
                        .push(i.url.split(['?', '#']).next().unwrap_or(&i.url).to_string());
                    let _ = write!(
                        out,
                        "<__NowakiImage src={{__nowakiImage{idx}}} alt={}",
                        js_attr(&i.alt)
                    );
                    if let Some(t) = &i.title {
                        let _ = write!(out, " title={}", js_attr(t));
                    }
                    out.push_str(" />");
                } else {
                    let _ = write!(out, "<img src={} alt={}", js_attr(&i.url), js_attr(&i.alt));
                    if let Some(t) = &i.title {
                        let _ = write!(out, " title={}", js_attr(t));
                    }
                    out.push_str(" loading=\"lazy\" decoding=\"async\" />");
                }
            }
            Node::Table(t) => {
                out.push_str("<table>\n");
                for (row_i, row) in t.children.iter().enumerate() {
                    let Node::TableRow(r) = row else { continue };
                    if row_i == 0 {
                        out.push_str("<thead>");
                    } else if row_i == 1 {
                        out.push_str("<tbody>");
                    }
                    out.push_str("<tr>");
                    for (col, cell) in r.children.iter().enumerate() {
                        let Node::TableCell(c) = cell else { continue };
                        let tag = if row_i == 0 { "th" } else { "td" };
                        let align = match t.align.get(col) {
                            Some(AlignKind::Left) => " align=\"left\"",
                            Some(AlignKind::Right) => " align=\"right\"",
                            Some(AlignKind::Center) => " align=\"center\"",
                            _ => "",
                        };
                        self.wrap(tag, align, &c.children, out);
                    }
                    out.push_str("</tr>");
                    if row_i == 0 {
                        out.push_str("</thead>\n");
                    }
                }
                if t.children.len() > 1 {
                    out.push_str("</tbody>");
                }
                out.push_str("</table>\n");
            }
            Node::FootnoteReference(f) => {
                let id = slug(&f.identifier);
                let _ = write!(
                    out,
                    "<sup><a href={} id={} data-footnote-ref>{}</a></sup>",
                    js_attr(&format!("#fn-{id}")),
                    js_attr(&format!("fnref-{id}")),
                    js_string_expr(f.label.as_deref().unwrap_or(&f.identifier))
                );
            }
            Node::FootnoteDefinition(f) => {
                let id = slug(&f.identifier);
                let _ = write!(
                    out,
                    "<div id={} data-footnote>",
                    js_attr(&format!("fn-{id}"))
                );
                self.children(&f.children, out);
                let _ = writeln!(
                    out,
                    "<a href={} data-footnote-backref>↩</a></div>",
                    js_attr(&format!("#fnref-{id}"))
                );
            }
            Node::MdxFlowExpression(e) => {
                let _ = writeln!(out, "{{{}}}", e.value);
            }
            Node::MdxTextExpression(e) => {
                let _ = write!(out, "{{{}}}", e.value);
            }
            Node::MdxJsxFlowElement(e) => {
                self.jsx(e.name.as_deref(), &e.attributes, &e.children, out);
                out.push('\n');
            }
            Node::MdxJsxTextElement(e) => {
                self.jsx(e.name.as_deref(), &e.attributes, &e.children, out)
            }
            // ESM is hoisted by to_tsx; references and the rest are rare in MDX: kept as text.
            Node::MdxjsEsm(_) | Node::Yaml(_) | Node::Toml(_) | Node::Definition(_) => {}
            Node::Html(h) => text(&h.value, out),
            other => {
                if let Some(children) = other.children() {
                    self.children(children, out);
                } else {
                    text(&other.to_string(), out);
                }
            }
        }
    }

    fn jsx(
        &mut self,
        name: Option<&str>,
        attrs: &[AttributeContent],
        children: &[Node],
        out: &mut String,
    ) {
        let name = name.unwrap_or("");
        let _ = write!(out, "<{name}");
        for a in attrs {
            match a {
                AttributeContent::Expression(e) => {
                    let _ = write!(out, " {{{}}}", e.value);
                }
                AttributeContent::Property(p) => match &p.value {
                    None => {
                        let _ = write!(out, " {}", p.name);
                    }
                    Some(AttributeValue::Literal(s)) => {
                        let _ = write!(out, " {}={}", p.name, js_attr(s));
                    }
                    Some(AttributeValue::Expression(e)) => {
                        let _ = write!(out, " {}={{{}}}", p.name, e.value);
                    }
                },
            }
        }
        if children.is_empty() && !name.is_empty() {
            out.push_str(" />");
            return;
        }
        out.push('>');
        self.children(children, out);
        let _ = write!(out, "</{name}>");
    }
}

/// The text of a node and its descendants (for heading ids and anchors).
fn plain_text(node: &Node) -> String {
    match node {
        Node::Text(t) => t.value.clone(),
        Node::InlineCode(c) => c.value.clone(),
        other => other
            .children()
            .map(|c| c.iter().map(plain_text).collect::<String>())
            .unwrap_or_default(),
    }
}

fn is_local(url: &str) -> bool {
    !(url.is_empty()
        || url.starts_with('/')
        || url.starts_with('#')
        || url.contains("://")
        || url.starts_with("data:")
        || url.starts_with("//"))
        && crate::is_asset(std::path::Path::new(
            url.split(['?', '#']).next().unwrap_or(url),
        ))
}

fn slug(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect()
}

/// A JS string literal (JSON is a subset).
fn js_string(s: &str) -> String {
    serde_json::to_string(s).expect("strings serialize")
}

/// An attribute value: `{"…"}`, so quotes and braces can't break out.
fn js_attr(s: &str) -> String {
    format!("{{{}}}", js_string(s))
}

fn js_string_expr(s: &str) -> String {
    format!("{{{}}}", js_string(s))
}

/// Text as a JSX expression (`{"…"}`), so `{`, `<`, and `}` in prose stay prose.
fn text(s: &str, out: &mut String) {
    if !s.is_empty() {
        out.push_str(&js_string_expr(s));
    }
}

/// `<tag attrs…>inner</tag>` HTML (from the highlighter) as one JSX element with its inner HTML
/// set raw: `<pre style={"…"} dangerouslySetInnerHTML={{ __html: "…" }} />`.
fn raw_element(html: &str, out: &mut String) {
    let html = html.trim();
    let Some(open_end) = html.find('>') else {
        return text(html, out);
    };
    let open = &html[1..open_end];
    let (tag, attrs) = open.split_once(' ').unwrap_or((open, ""));
    let close = format!("</{tag}>");
    let inner = html[open_end + 1..]
        .strip_suffix(close.as_str())
        .unwrap_or(&html[open_end + 1..]);
    let _ = write!(out, "<{tag}");
    // Only `name="value"` pairs come out of the highlighter.
    let mut rest = attrs.trim();
    while let Some((name, after)) = rest.split_once("=\"") {
        let Some((value, tail)) = after.split_once('"') else {
            break;
        };
        let value = value.replace("&quot;", "\"").replace("&amp;", "&");
        let jsx_name = if name.trim() == "class" {
            "class"
        } else {
            name.trim()
        };
        let _ = write!(out, " {jsx_name}={}", js_attr(&value));
        rest = tail.trim();
    }
    let _ = write!(
        out,
        " dangerouslySetInnerHTML={{{{ __html: {} }}}} />",
        js_string(inner)
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_becomes_jsx_and_esm_is_hoisted() {
        let src = "---\ntitle: x\n---\nimport Counter from \"../islands/Counter.tsx\";\nexport const title = \"Hi\";\n\n# Hello {name}\n\nSome *em* and `code` with <b>bold</b>.\n\n<Counter client:visible count={3} label='a \"q\"' />\n\n- [x] done\n- todo\n\n| a | b |\n|:-|-:|\n| 1 | 2 |\n";
        let tsx = to_tsx(src).unwrap();
        assert!(
            tsx.contains("import Counter from \"../islands/Counter.tsx\";"),
            "{tsx}"
        );
        assert!(tsx.contains("export const title = \"Hi\";"), "{tsx}");
        assert!(!tsx.contains("title: x"), "frontmatter is skipped: {tsx}");
        assert!(
            tsx.contains("<h1 id={\"hello-\"}>{\"Hello \"}{name}</h1>"),
            "{tsx}"
        );
        assert!(tsx.contains("<em>{\"em\"}</em>"), "{tsx}");
        assert!(tsx.contains("<code>{\"code\"}</code>"), "{tsx}");
        assert!(tsx.contains("<b>{\"bold\"}</b>"), "{tsx}");
        assert!(
            tsx.contains("<Counter client:visible count={3} label={\"a \\\"q\\\"\"} />"),
            "{tsx}"
        );
        assert!(
            tsx.contains("<input type=\"checkbox\" disabled checked />"),
            "{tsx}"
        );
        assert!(
            tsx.contains("<th align=\"left\">{\"a\"}</th><th align=\"right\">{\"b\"}</th>"),
            "{tsx}"
        );
        assert!(
            tsx.contains("export default function MDXContent(props)"),
            "{tsx}"
        );
    }

    #[test]
    fn prose_cannot_break_out_of_jsx() {
        let tsx = to_tsx("A \\< b and \\{not an expression\\} and `}<`\n").unwrap();
        assert!(
            tsx.contains("{\"A < b and {not an expression} and \"}"),
            "{tsx}"
        );
        assert!(tsx.contains("<code>{\"}<\"}</code>"), "{tsx}");
    }

    #[test]
    fn code_is_highlighted_and_images_go_through_image() {
        let tsx =
            to_tsx("```rust\nfn main() {}\n```\n\n![A cat](./cat.jpg \"T\") ![logo](/logo.svg)\n")
                .unwrap();
        assert!(tsx.contains("<pre style={\""), "{tsx}");
        assert!(
            tsx.contains("dangerouslySetInnerHTML={{ __html: \"<code class=\\\"language-rust\\\">"),
            "{tsx}"
        );
        assert!(
            tsx.contains("import __nowakiImage0 from \"./cat.jpg?image\";"),
            "{tsx}"
        );
        assert!(
            tsx.contains("<__NowakiImage src={__nowakiImage0} alt={\"A cat\"} title={\"T\"} />"),
            "{tsx}"
        );
        assert!(
            tsx.contains("<img src={\"/logo.svg\"} alt={\"logo\"}"),
            "{tsx}"
        );
    }

    #[test]
    fn headings_match_markdown_anchors() {
        let h = headings("# Intro\n\n## Why `nowaki`?\n\n## Intro\n").unwrap();
        let ids: Vec<&str> = h.iter().map(|x| x.id.as_str()).collect();
        assert_eq!(ids, ["intro", "why-nowaki", "intro-1"]);
        assert_eq!(h[1].text, "Why nowaki?");
    }
}
