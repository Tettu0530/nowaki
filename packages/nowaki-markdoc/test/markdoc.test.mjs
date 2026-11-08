import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { h } from "preact";
import { renderToString } from "preact-render-to-string";
import { compileMarkdoc, markdoc } from "../index.js";
import { renderMarkdoc } from "../render.js";
import { parseToml, parseYaml, splitFrontmatter } from "../frontmatter.js";

const root = "/app";
const here = path.dirname(fileURLToPath(import.meta.url));
const tags = {
  callout: { render: "Callout", attributes: { type: { type: String, default: "note" } } },
  badge: { render: "span", attributes: { tone: { type: String } }, selfClosing: true },
};

// Evaluates an emitted module: its imports point at this package and a temp components module.
// The temp dir is under the package so `preact` resolves.
async function load(source, components = "export function Callout({ type, children }) { return h('aside', { class: 'callout ' + type }, children); }") {
  const dir = mkdtempSync(path.join(here, ".tmp-"));
  try {
    mkdirSync(path.join(dir, "markdoc"));
    writeFileSync(path.join(dir, "markdoc/components.mjs"), `import { h } from "preact";\n${components}\n`);
    const id = path.join(dir, "routes/page.mdoc");
    const code = compileMarkdoc(source, id, { root: dir, components: "./markdoc/components.mjs", tags });
    mkdirSync(path.join(dir, "routes"));
    const renderUrl = pathToFileURL(path.join(here, "../render.js")).href;
    const out = path.join(dir, "routes/page.mjs");
    writeFileSync(out, code.replace('"@nowaki-dev/markdoc/render"', JSON.stringify(renderUrl)));
    const mod = await import(pathToFileURL(out).href);
    return { code, mod, html: renderToString(h(mod.default, null)) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("compiles Markdoc to a module with headings, frontmatter and components", async () => {
  const { code, mod, html } = await load(
    "---\ntitle: Hello\ntags: [a, b]\n---\n# Hello *world*\n\n## Setup\n\n## Setup\n\n{% callout type=\"warning\" %}\nCareful {% badge tone=\"x\" /%}\n{% /callout %}\n\nTitle: {% $frontmatter.title %}\n",
  );
  assert.ok(code.includes('from "@nowaki-dev/markdoc/render"'), code);
  assert.ok(code.includes('from "../markdoc/components.mjs"'), code);
  assert.ok(!code.includes("@markdoc/markdoc"), "no Markdoc runtime in the module");
  assert.deepEqual(mod.frontmatter, { title: "Hello", tags: ["a", "b"] });
  assert.deepEqual(mod.headings, [
    { depth: 1, text: "Hello world", id: "hello-world" },
    { depth: 2, text: "Setup", id: "setup" },
    { depth: 2, text: "Setup", id: "setup-1" },
  ]);
  assert.ok(html.includes('<h1 id="hello-world">Hello <em>world</em></h1>'), html);
  assert.ok(html.includes('<h2 id="setup-1">'), html);
  assert.ok(html.includes('<aside class="callout warning"><p>Careful <span tone="x"></span></p></aside>'), html);
  assert.ok(html.includes("<p>Title: Hello</p>"), html);
});

test("an author's {% #id %} wins and is not reused", async () => {
  const { mod } = await load("# Intro {% #intro %}\n\n# Intro\n");
  assert.deepEqual(mod.headings.map((x) => x.id), ["intro", "intro-1"]);
});

test("validation errors fail the transform with file and line", () => {
  assert.throws(
    () => compileMarkdoc("---\ntitle: x\n---\n\n{% nope %}x{% /nope %}\n", "/app/routes/a.mdoc", { root, tags }),
    (err) => err.message.includes("/app/routes/a.mdoc:5: Undefined tag: 'nope'"),
  );
  assert.throws(
    () => compileMarkdoc('{% callout type=1 %}x{% /callout %}\n', "/app/a.mdoc", { root, tags, components: "./c.tsx" }),
    /Markdoc validation failed/,
  );
});

test("a schema that renders a component needs the components option", () => {
  assert.throws(
    () => compileMarkdoc("{% callout %}x{% /callout %}\n", "/app/a.mdoc", { root, tags }),
    /markdoc\(\{ components/,
  );
  // Without a component in the tree it compiles.
  assert.ok(compileMarkdoc("# Plain\n", "/app/a.mdoc", { root, tags }).includes("const components = {}"));
});

test("text and attributes are escaped; raw HTML stays text", async () => {
  const { html } = await load('Hi <script>alert(1)</script> & {% badge tone="\\"><img src=x onerror=alert(1)>" /%}\n');
  assert.ok(!html.includes("<script>"), html);
  assert.ok(html.includes("&lt;script>") || html.includes("&lt;script&gt;"), html);
  assert.ok(!html.includes("<img"), html);
  assert.ok(html.includes("&quot;>&lt;img") || html.includes("&quot;&gt;&lt;img"), html);
});

test("the renderer drops unsafe URLs, event handlers and unknown components", () => {
  const out = renderToString(
    renderMarkdoc(["", {}, [
      ["a", { href: "java\tscript:alert(1)", onclick: "x()", title: "t" }, ["a"]],
      ["a", { href: "/ok" }, ["b"]],
      ["img", { src: "data:text/html,x", alt: "c" }, []],
    ]]),
  );
  assert.equal(out, '<a title="t">a</a><a href="/ok">b</a><img alt="c"/>');
  assert.throws(() => renderMarkdoc(["script", {}, ["x"]]), /refusing to render/);
  assert.throws(() => renderMarkdoc(["Missing", {}, []], {}), /not exported/);
  assert.throws(() => renderMarkdoc(["toString", {}, []], {}), /refusing/);
  assert.throws(() => renderMarkdoc(["Constructor", {}, []], {}), /not exported/);
  const Comp = (p) => h("b", null, String(p.dangerouslySetInnerHTML === undefined), p.children);
  assert.equal(renderToString(renderMarkdoc(["Comp", { dangerouslySetInnerHTML: { __html: "<i>" } }, ["x"]], { Comp })), "<b>truex</b>");
});

test("the plugin only claims .mdoc files", () => {
  const p = markdoc({ tags });
  assert.equal(p.name, "nowaki-markdoc");
  assert.equal(p.transform("export {}", "/app/a.tsx"), null);
  assert.ok(p.transform("# Hi\n", "/app/a.mdoc").includes("export const headings"));
  assert.throws(() => markdoc({ tags: { x: { render: () => null } } }), /render must be a string/);
});

test("frontmatter: fences, YAML and TOML subsets", () => {
  assert.equal(splitFrontmatter("# no\n").format, null);
  const s = splitFrontmatter("\uFEFF+++\r\ntitle = \"T\"\r\n+++\r\nbody\n");
  assert.deepEqual([s.format, s.raw, s.body, s.lines], ["toml", 'title = "T"\r\n', "body\n", 3]);
  assert.equal(splitFrontmatter("---\nunclosed\n").format, null);
  assert.deepEqual(parseYaml("a: 1\nb: 'it''s'\nc: \"q\\n\"\nd: true\ne:\nf:\n  - x\n  - 2\ng: [1, 'two']  # c\nh: plain text\n"), {
    a: 1, b: "it's", c: "q\n", d: true, e: null, f: ["x", 2], g: [1, "two"], h: "plain text",
  });
  assert.throws(() => parseYaml("a:\n  b: 1\n"), /parseFrontmatter/);
  assert.throws(() => parseYaml("a: |\n  x\n"), /parseFrontmatter/);
  assert.deepEqual(parseToml('t = "x" # c\nn = 1_000\nf = 1.5\nb = false\nd = 2026-11-05\nl = ["a", 2]\n'), {
    t: "x", n: 1000, f: 1.5, b: false, d: "2026-11-05", l: ["a", 2],
  });
  assert.throws(() => parseToml("[table]\n"), /parseFrontmatter/);
  const custom = compileMarkdoc("---\nanything: {x: 1}\n---\nHi\n", "/app/a.mdoc", { root, parseFrontmatter: (raw, f) => ({ raw, f }) });
  assert.ok(custom.includes('"f":"yaml"'), custom);
  // Error lines count from the top of the file, frontmatter included.
  assert.throws(() => compileMarkdoc("+++\nx = 1\n+++\n{% nope /%}\n", "/app/a.mdoc", { root }), /a\.mdoc:4:/);
});
