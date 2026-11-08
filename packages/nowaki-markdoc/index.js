// Markdoc for Nowaki. A plugin whose `transform` turns a `.mdoc` file into a TSX module at build /
// dev time: Markdoc parses, validates and transforms it here (in the plugin host), and the module
// carries only the resulting tree as data, rendered by `./render.js` with Preact.

import path from "node:path";
import Markdoc from "@markdoc/markdoc";
import { parseToml, parseYaml, splitFrontmatter } from "./frontmatter.js";

export const { Tag, nodes, tags, functions } = Markdoc;

const SCHEMA_KEYS = ["tags", "nodes", "variables", "functions", "partials"];

function checkOptions(options) {
  if (options == null || typeof options !== "object") throw new TypeError("markdoc(options): options must be an object");
  if (options.components != null && typeof options.components !== "string") {
    throw new TypeError('markdoc({ components }): a path to a module, like "./markdoc/components.tsx"');
  }
  for (const key of ["tags", "nodes"]) {
    for (const [name, schema] of Object.entries(options[key] ?? {})) {
      if (schema?.render != null && typeof schema.render !== "string") {
        throw new TypeError(`markdoc({ ${key} }): ${name}.render must be a string (an element or a component name)`);
      }
    }
  }
}

// comrak's anchorizer, which Nowaki uses for Markdown and MDX headings: the same text gets the same
// id in every format.
function anchorizer() {
  const seen = new Set();
  return {
    reserve(id) {
      seen.add(id);
    },
    anchorize(text) {
      const base = text
        .toLowerCase()
        .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
        .replaceAll(" ", "-");
      let id = base;
      for (let n = 1; seen.has(id); n++) id = `${base}-${n}`;
      seen.add(id);
      return id;
    },
  };
}

function inlineText(node) {
  if (node.type === "text" || node.type === "code") return String(node.attributes.content ?? "");
  return node.children.map(inlineText).join("");
}

// Gives each heading an id (unless the author wrote `{% #id %}`) and lists them.
function collectHeadings(ast) {
  const headings = [];
  const slugs = anchorizer();
  const all = [...ast.walk()].filter((n) => n.type === "heading");
  for (const n of all) if (typeof n.attributes.id === "string") slugs.reserve(n.attributes.id);
  for (const n of all) {
    const text = inlineText(n).trim();
    if (typeof n.attributes.id !== "string") n.attributes.id = slugs.anchorize(text);
    headings.push({ depth: n.attributes.level, text, id: n.attributes.id });
  }
  return headings;
}

function serialize(node) {
  if (node == null || typeof node === "boolean") return null;
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return ["", {}, node.map(serialize).filter((n) => n !== null)];
  if (Markdoc.Tag.isTag(node)) {
    if (typeof node.name !== "string") throw new Error("a schema rendered a non-string tag name; use a component name from the components module");
    return [node.name, node.attributes ?? {}, (node.children ?? []).map(serialize).filter((n) => n !== null)];
  }
  return null;
}

function relativeImport(fromFile, target) {
  let rel = path.relative(path.dirname(fromFile), target).split(path.sep).join("/");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel;
}

// JSON is valid JavaScript; U+2028/2029 are escaped for parsers that predate ES2019.
function js(value) {
  return JSON.stringify(value).replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
}

// Compiles one `.mdoc` source into a TSX module. Throws on Markdoc validation errors.
export function compileMarkdoc(source, id, options = {}) {
  checkOptions(options);
  const root = options.root ?? process.cwd();
  const fm = splitFrontmatter(source);
  let frontmatter = {};
  if (fm.format) {
    try {
      frontmatter = options.parseFrontmatter
        ? (options.parseFrontmatter(fm.raw, fm.format) ?? {})
        : fm.format === "yaml"
          ? parseYaml(fm.raw)
          : parseToml(fm.raw);
    } catch (err) {
      throw new Error(`${id}: ${err?.message ?? err}`);
    }
  }
  // Blank lines in place of the frontmatter keep Markdoc's line numbers those of the file.
  const body = "\n".repeat(fm.lines) + fm.body;
  const ast = Markdoc.parse(body);
  const config = {};
  for (const key of SCHEMA_KEYS) if (options[key] != null) config[key] = options[key];
  config.variables = { frontmatter, ...(options.variables ?? {}) };
  const errors = Markdoc.validate(ast, config).filter((e) => e.error.level === "error" || e.error.level === "critical");
  if (errors.length) {
    const lines = errors.map((e) => {
      const line = e.lines?.length ? `:${e.lines[0] + 1}` : "";
      return `  ${id}${line}: ${e.error.message} (${e.error.id})`;
    });
    throw new Error(`Markdoc validation failed:\n${lines.join("\n")}`);
  }
  const headings = collectHeadings(ast);
  const tree = serialize(Markdoc.transform(ast, config));

  if (!options.components && hasComponent(tree)) {
    throw new Error(`${id}: the Markdoc schema renders components, so markdoc({ components: "./markdoc/components.tsx" }) is required`);
  }
  const componentsImport = options.components
    ? `import * as components from ${js(relativeImport(id, path.resolve(root, options.components)))};\n`
    : "const components = {};\n";
  return (
    `import { renderMarkdoc } from "@nowaki-dev/markdoc/render";\n` +
    componentsImport +
    `const tree = ${js(tree)};\n` +
    `export const frontmatter = ${js(frontmatter)};\n` +
    `export const headings = ${js(headings)};\n` +
    `export default function MarkdocContent() {\n  return renderMarkdoc(tree, components);\n}\n`
  );
}

function hasComponent(node) {
  if (!Array.isArray(node)) return false;
  return /^[A-Z]/.test(node[0]) || node[2].some(hasComponent);
}

// The plugin: `plugins: [markdoc({ components: "./markdoc/components.tsx", tags, nodes })]`.
export function markdoc(options = {}) {
  checkOptions(options);
  return {
    name: "nowaki-markdoc",
    transform(code, id) {
      if (!id.endsWith(".mdoc")) return null;
      return compileMarkdoc(code, id, options);
    },
  };
}

export default markdoc;
