// Public API surface snapshots (api/*.txt). Each file lists one part of what Nowaki promises to
// keep working: runtime types, route-module exports, file conventions, config keys, CLI flags,
// environment variables, endpoints / headers / cookies, client events and attributes.
//
//   node scripts/api-surface.mjs                  write api/*.txt (and api/cli.txt through cargo)
//   node scripts/api-surface.mjs --check          fail when a snapshot is out of date or a new name
//                                                 is unclassified (CI)
//   node scripts/api-surface.mjs --check --base <ref>
//                                                 also list stable entries removed or changed
//                                                 since <ref> (CI passes the PR's base commit)
//
// Format (api/README.md): `[status]` or `[status title]` section headers, one entry per line,
// `#` comments. Text after "  # " on an entry line is a comment. An entry's identity is its
// section header plus its text without the comment, so editing a comment never counts as a change.
// Only `[stable ...]` sections are covered by the compatibility promise.
//
// api/cli.txt is written by a unit test in crates/nowaki/src/main.rs (clap introspection):
// NOWAKI_UPDATE_SNAPSHOTS=1 cargo test -p nowaki --bin nowaki cli_surface. `cargo test` fails when
// it is out of date; this script runs that test in write mode unless --no-cargo is given.
//
// Generation is deterministic: files are read with "\n" line endings, directories are walked in
// sorted order, paths are printed with "/", and Rust `#[cfg(test)]` modules are left out.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/// From this workspace version on, a PR that removes or changes a stable entry needs the
/// `breaking` label. Before it (the 0.20.0 cleanups) a removal is reported but allowed.
export const FREEZE_VERSION = "0.20.0";
export const BREAKING_LABEL = "breaking";

export const STATUSES = ["stable", "dev", "internal", "external", "ignored", "unclassified"];
const COVERED = "stable";

// ---------------------------------------------------------------------------------------------
// Snapshot text: parse, compare

const COMMENT = /\s{2,}#\s.*$|\s{2,}#$/;

/// Entries of a snapshot as identities: "<section header>\t<entry text>". `onlyCovered` keeps
/// only `[stable ...]` sections.
export function parseSnapshot(text, { onlyCovered = false } = {}) {
  const out = [];
  let section = null;
  for (const raw of normalize(text).split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const header = line.match(/^\[(\S+)(?:\s+(.+))?\]$/);
    if (header) {
      section = { status: header[1], header: line };
      continue;
    }
    if (!section) throw new Error(`entry before any [section]: ${line}`);
    if (onlyCovered && section.status !== COVERED) continue;
    out.push(`${section.header}\t${line.replace(COMMENT, "").trim()}`);
  }
  return out;
}

/// Stable entries in `before` that are missing from `after` (removed, renamed or changed).
export function removedEntries(before, after) {
  const now = new Set(parseSnapshot(after, { onlyCovered: true }));
  return parseSnapshot(before, { onlyCovered: true }).filter((e) => !now.has(e));
}

/// Stable entries in `after` that are new.
export function addedEntries(before, after) {
  const was = new Set(parseSnapshot(before, { onlyCovered: true }));
  return parseSnapshot(after, { onlyCovered: true }).filter((e) => !was.has(e));
}

/// Version compare for "x.y.z" (prerelease tags ignored).
export function versionAtLeast(version, min) {
  const p = (v) => v.split("-")[0].split(".").map(Number);
  const [a, b] = [p(version), p(min)];
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

// ---------------------------------------------------------------------------------------------
// Files

const normalize = (s) => s.replace(/\r\n?/g, "\n");
const rel = (root, abs) => path.relative(root, abs).split(path.sep).join("/");

function read(root, file) {
  return normalize(readFileSync(path.join(root, file), "utf8"));
}

/// Source text with the Rust test module cut off (tests sit at the end of each file).
function sourceText(root, file) {
  const text = read(root, file);
  if (!file.endsWith(".rs")) return text;
  const at = text.search(/^#\[cfg\(test\)\]\s*\n\s*mod tests/m);
  return at === -1 ? text : text.slice(0, at);
}

/// Files under `dir` (relative to root) whose name matches `ext`, sorted, without node_modules.
function walk(root, dir, ext) {
  const out = [];
  const visit = (d) => {
    const abs = path.join(root, d);
    if (!existsSync(abs)) return;
    for (const name of readdirSync(abs).sort()) {
      if (name === "node_modules" || name === "target" || name.startsWith(".")) continue;
      const p = `${d}/${name}`;
      if (statSync(path.join(root, p)).isDirectory()) visit(p);
      else if (ext.test(name)) out.push(p);
    }
  };
  visit(dir);
  return out;
}

const header = (lines) => lines.map((l) => (l ? `# ${l}` : "#")).join("\n") + "\n";

// ---------------------------------------------------------------------------------------------
// TypeScript declarations (runtime subpaths, markdoc, template ambient types)

const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
// The printer writes tuple types as "[ a, b ]" and an empty body as "{ }"; tighten both.
const oneLine = (s) => s.replace(/\s+/g, " ").replace(/\{ \}/g, "{}").replace(/\[ \]/g, "[]").replace(/\[ (?=\S)/g, "[").replace(/(?<=\S) \]/g, "]").trim();

function parse(root, file) {
  const kind = /\.d\.ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  return ts.createSourceFile(file, read(root, file), ts.ScriptTarget.Latest, true, kind);
}

const hasExport = (node) => (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0;
const print = (node, sf) => oneLine(printer.printNode(ts.EmitHint.Unspecified, node, sf));

/// One line per declaration; interfaces and classes get a header line plus a line per member,
/// so adding an optional member is an addition, not a change.
function declarationLines(sf) {
  const lines = [];
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) continue;
    const exported = hasExport(st) || ts.isExportAssignment(st) || ts.isExportDeclaration(st);
    const local = !exported && (ts.isTypeAliasDeclaration(st) || ts.isInterfaceDeclaration(st));
    if (!exported && !local && !ts.isModuleDeclaration(st)) continue;
    if (ts.isInterfaceDeclaration(st) || ts.isClassDeclaration(st)) {
      const empty = ts.isInterfaceDeclaration(st)
        ? ts.factory.updateInterfaceDeclaration(st, st.modifiers, st.name, st.typeParameters, st.heritageClauses, [])
        : ts.factory.updateClassDeclaration(st, st.modifiers, st.name, st.typeParameters, st.heritageClauses, []);
      lines.push(print(empty, sf));
      const name = st.name?.text ?? "default";
      for (const m of st.members) {
        if (m.modifiers?.some((x) => x.kind === ts.SyntaxKind.PrivateKeyword)) continue;
        lines.push(`${name}.${print(m, sf)}`);
      }
      continue;
    }
    lines.push(print(st, sf));
  }
  return lines;
}

/// Value (runtime) export names of a .d.ts or JS module.
function valueExports(sf) {
  const names = new Set();
  for (const st of sf.statements) {
    if (ts.isExportAssignment(st)) names.add("default");
    else if (ts.isExportDeclaration(st) && !st.isTypeOnly && st.exportClause && ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) if (!el.isTypeOnly) names.add(el.name.text);
    } else if (hasExport(st)) {
      const isDefault = (ts.getCombinedModifierFlags(st) & ts.ModifierFlags.Default) !== 0;
      if (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) names.add(isDefault ? "default" : st.name.text);
      else if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name)) names.add(d.name.text);
          else if (ts.isObjectBindingPattern(d.name)) for (const el of d.name.elements) names.add(el.name.getText(sf));
        }
      }
    }
  }
  return names;
}

/// A package's `exports` map → one `[stable <subpath>]` section per types file. Wildcard
/// subpaths are internal (noted, not listed).
function packageTypes(root, dir, title) {
  const pkg = JSON.parse(read(root, `${dir}/package.json`));
  const out = [];
  const wild = [];
  for (const sub of Object.keys(pkg.exports).sort()) {
    const target = pkg.exports[sub];
    if (sub.includes("*")) {
      wild.push(sub);
      continue;
    }
    const types = `${dir}/${target.types.replace(/^\.\//, "")}`;
    const impl = `${dir}/${target.default.replace(/^\.\//, "")}`;
    out.push("", `[stable ${sub}]`, `# ${types}`);
    const dts = parse(root, types);
    out.push(...declarationLines(dts));
    const declared = valueExports(dts);
    const actual = valueExports(parse(root, impl));
    const missing = [...declared].filter((n) => !actual.has(n)).sort();
    const extra = [...actual].filter((n) => !declared.has(n)).sort();
    if (missing.length) throw new Error(`${types} declares ${missing.join(", ")}, which ${impl} does not export`);
    if (extra.length) out.push(`# ${impl} also exports (undeclared, not covered): ${extra.join(", ")}`);
  }
  const head = [
    `${title}: every declaration in the types file of each \`exports\` subpath, printed without`,
    "comments, one line per declaration (interface and class members on their own lines).",
    "Lines without `export` are local types the exported ones use.",
  ];
  if (wild.length) {
    head.push(`Not covered: the wildcard subpaths ${wild.join(", ")} (files the CLI's generated code imports).`);
  }
  return header(head) + out.join("\n") + "\n";
}

export function genRuntime(root) {
  return packageTypes(root, "packages/nowaki-runtime", "@nowaki-dev/runtime");
}

export function genMarkdoc(root) {
  return packageTypes(root, "packages/nowaki-markdoc", "@nowaki-dev/markdoc");
}

export function genTemplateTypes(root) {
  const dir = "packages/create-nowaki/templates/_shared";
  const out = [];
  for (const file of walk(root, dir, /\.d\.ts$/)) {
    out.push("", `[stable ${file.slice(dir.length + 1)}]`);
    out.push(...declarationLines(parse(root, file)));
  }
  return (
    header([
      "Type files every scaffolded app gets (create-nowaki templates/_shared): ambient module",
      "declarations for asset / CSS / MDX / Markdoc / virtual imports, import.meta.env, and the",
      "client:* JSX attributes.",
    ]) +
    out.join("\n") +
    "\n"
  );
}

// ---------------------------------------------------------------------------------------------
// Classified inventories: names found in the code, each placed in a status section by hand.

/// `found`: Map id → Set of files it was found in. `previous`: the current file (or ""), whose
/// sections give each id its status and entry text. New ids go to [unclassified]; ids no longer
/// found are dropped (a removal, which the --base check reports when they were stable).
export function classify(found, previous, title) {
  const known = new Map();
  let status = null;
  for (const raw of normalize(previous).split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const h = line.match(/^\[(\S+)(?:\s+.+)?\]$/);
    if (h) {
      status = h[1];
      continue;
    }
    const text = line.replace(COMMENT, "").trim();
    const id = text.split(/:\s|\s/)[0];
    if (status && status !== "unclassified") known.set(id, { status, text });
  }
  const sections = new Map(STATUSES.map((s) => [s, []]));
  for (const id of [...found.keys()].sort()) {
    const k = known.get(id);
    const st = k && STATUSES.includes(k.status) ? k.status : "unclassified";
    const files = [...found.get(id)].sort();
    sections.get(st).push(`${k?.text ?? id}  # ${files.join(", ")}`);
  }
  const out = [header(title).trimEnd()];
  for (const [st, lines] of sections) {
    if (!lines.length) continue;
    out.push("", `[${st}]`, ...lines);
  }
  return out.join("\n") + "\n";
}

const CLASSIFY_HELP = [
  "Sections: [stable] is covered by semver; [dev] dev-only; [internal] not covered (may change in",
  "any release); [external] standard names Nowaki reads but doesn't own; [ignored] matches that",
  "aren't this kind of surface. A name the scan finds that isn't listed lands in [unclassified],",
  "and --check fails until it is moved to a section. The comment after each entry lists where",
  "the scan found it.",
];

function scanTokens(root, files, patterns, found = new Map()) {
  for (const file of files) {
    const text = sourceText(root, file);
    for (const re of patterns) {
      for (const m of text.matchAll(re)) {
        const id = m[1] ?? m[0];
        if (!found.has(id)) found.set(id, new Set());
        found.get(id).add(file);
      }
    }
  }
  return found;
}

const SOURCE_FILES = (root) => [
  ...walk(root, "crates/nowaki/src", /\.rs$/),
  ...walk(root, "crates/nowaki-core/src", /\.rs$/),
  ...walk(root, "packages/nowaki-runtime", /\.(m?js|d\.ts)$/),
];

export function genEnv(root, previous) {
  const files = SOURCE_FILES(root);
  const found = scanTokens(root, files, [
    /\b((?:NOWAKI|OTEL|CLOUDFLARE)_[A-Z0-9_]+)\b/g,
    /process\.env\.([A-Z_][A-Z0-9_]*)/g,
    /process\.env\[\s*["']([A-Z_][A-Z0-9_]*)["']\s*\]/g,
    /env::var(?:_os)?\(\s*"([A-Z_][A-Z0-9_]*)"\s*\)/g,
    /Deno\.env\.get\(\s*["']([A-Z_][A-Z0-9_]*)["']\s*\)/g,
  ]);
  return classify(found, previous, [
    "Environment variables: every NOWAKI_* / OTEL_* / CLOUDFLARE_* name, and every name read",
    "through process.env / env::var / Deno.env, in crates/*/src and packages/nowaki-runtime.",
    ...CLASSIFY_HELP,
  ]);
}

export function genHttp(root, previous) {
  const files = SOURCE_FILES(root);
  const found = scanTokens(root, files, [
    /(\/__nowaki\/[a-z0-9-]+)/g,
    /"(\/@[a-z]+\/)/g,
    /(\/_nowaki\/)/g,
    /\b(x-nowaki-[a-z-]*[a-z])\b/gi,
  ]);
  // Header names are case-insensitive: fold to lowercase.
  for (const id of [...found.keys()]) {
    const lower = id.toLowerCase();
    if (lower === id) continue;
    if (!found.has(lower)) found.set(lower, new Set());
    for (const f of found.get(id)) found.get(lower).add(f);
    found.delete(id);
  }
  scanTokens(root, files, [/\b(nowaki_(?!core\b)[a-z]+)\b/g], found);
  return classify(found, previous, [
    "HTTP surface: /__nowaki/* endpoints, /@*/ dev paths, the /_nowaki/ asset prefix, x-nowaki-*",
    "headers and nowaki_* cookies found in crates/*/src and packages/nowaki-runtime.",
    "Request / response formats of internal endpoints (wire protocols) are not covered.",
    ...CLASSIFY_HELP,
  ]);
}

export function genClient(root, previous) {
  const files = walk(root, "packages/nowaki-runtime/client", /\.m?js$/);
  const found = scanTokens(root, files, [/["'`](nowaki:[a-z-]+)/g, /\b(data-(?:live|nowaki)(?:-[a-z]+)*)\b/g]);
  return classify(found, previous, [
    "Client surface: nowaki:* DOM events and data-live* / data-nowaki-* attributes used by",
    "packages/nowaki-runtime/client. Generated markup (<nowaki-island> and friends) and",
    "window.__nowaki* globals are internal.",
    ...CLASSIFY_HELP,
  ]);
}

// Route-module reads: `mod.<name>` / `mod?.<name>` in the files that import route and island
// modules, plus the names nowaki-core reads from the AST. `config` in sidecar.mjs is the
// nowaki.config module, not a route.
const ROUTE_READERS = [
  "app.mjs",
  "document.mjs",
  "handler.mjs",
  "isr-urls.mjs",
  "live.mjs",
  "render.mjs",
  "sidecar.mjs",
  "static-paths.mjs",
  "web.mjs",
].map((f) => `packages/nowaki-runtime/server/${f}`);
// `serverFn` in server_fn.rs is the runtime call the transform rewrites, not a route export.
const ROUTE_READ_SKIP = {
  "packages/nowaki-runtime/server/sidecar.mjs": ["config"],
  "crates/nowaki-core/src/server_fn.rs": ["serverFn"],
};

export function genRouteExports(root, previous) {
  const found = new Map();
  const add = (id, file) => {
    if (!found.has(id)) found.set(id, new Set());
    found.get(id).add(file);
  };
  for (const file of ROUTE_READERS) {
    const text = sourceText(root, file);
    for (const m of text.matchAll(/\bmod\??\.([A-Za-z_$][\w$]*)/g)) {
      if (!(ROUTE_READ_SKIP[file] ?? []).includes(m[1])) add(m[1], file);
    }
    // API / file routes: the request method's export (any method name, also lowercased).
    if (/\bmod\[method\]/.test(text)) add("<METHOD>", file);
  }
  for (const file of walk(root, "crates/nowaki-core/src", /\.rs$/)) {
    const text = sourceText(root, file);
    for (const m of text.matchAll(/(?:id\.name|exported\.name\(\))\s*[!=]=\s*"(\w+)"/g)) {
      if (!(ROUTE_READ_SKIP[file] ?? []).includes(m[1])) add(m[1], file);
    }
  }
  const directives = read(root, "packages/nowaki-runtime/server/island-directive.mjs").match(/STRATEGIES = new Set\(\[([^\]]*)\]\)/);
  if (!directives) throw new Error("island-directive.mjs: STRATEGIES not found; update scripts/api-surface.mjs");
  for (const s of directives[1].matchAll(/"(\w+)"/g)) add(`client:${s[1]}`, "packages/nowaki-runtime/server/island-directive.mjs");
  return classify(found, previous, [
    "Route and island module exports the runtime reads (`mod.<name>` in the server files that",
    "load route modules, names nowaki-core reads from the AST) and the client:* island",
    "directives. <METHOD> is an API / file route's request-method export (GET, POST, ...).",
    "Each entry is `name: type`, the type as index.d.ts names it (\"untyped\" when it has none).",
    ...CLASSIFY_HELP,
  ]);
}

// ---------------------------------------------------------------------------------------------
// nowaki.config keys and plugin hooks

export function genConfig(root) {
  const site = "packages/nowaki-runtime/server/site-config.mjs";
  const host = "packages/nowaki-runtime/server/plugin-host.mjs";
  const fonts = "crates/nowaki/src/fonts.rs";
  const fontsFetch = "packages/nowaki-runtime/server/fonts-fetch.mjs";
  const siteText = read(root, site);
  const hostText = read(root, host);

  // CONFIG_KEYS: the top-level keys normalizeConfig accepts (any other one throws).
  const topList = siteText.match(/export const CONFIG_KEYS = Object\.freeze\(\[([^\]]*)\]\)/);
  if (!topList) throw new Error(`${site}: CONFIG_KEYS not found; update scripts/api-surface.mjs`);
  const top = new Set(strings(topList[1]));
  // A top-level key the runtime reads must be in CONFIG_KEYS, or no config could set it.
  for (const t of [siteText, hostText]) {
    for (const m of t.matchAll(/(?<![\w./-])config\.([A-Za-z_]\w*)\b(?!\.)/g)) {
      if (!top.has(m[1])) throw new Error(`config.${m[1]} is read but not in CONFIG_KEYS (${site}); update it`);
    }
  }

  // keys(obj, ["a", "b"], label): the allowed keys of a nested object (unknown ones throw). The
  // label is a string, a template, or `label`, the closest `const label = ...` above the call.
  const byLabel = new Map();
  for (const m of siteText.matchAll(/\bkeys\(\w+, \[([^\]]*)\], ([^)]*?\)?)\);/g)) {
    let label = m[2].trim();
    const outer = [...siteText.slice(0, m.index).matchAll(/const label = `([^`]+)`;/g)].pop()?.[1] ?? "";
    label = label.replace(/^label$/, `\`${outer}\``).replace(/\$\{label\}/, outer);
    label = label.replace(/^[`"]|[`"]$/g, "").replace(/\[\$\{i\}\]/g, "[]");
    // A list built from constants (`[...FONT_KEYS.common, ...mine]`) is listed from FONT_KEYS below.
    if (strings(m[1]).length) byLabel.set(label, strings(m[1]));
  }

  const trailing = siteText.match(/\[("never", "always", "ignore")\]\.includes\(trailing\)/);
  if (!trailing) throw new Error(`${site}: trailingSlash values not found; update scripts/api-surface.mjs`);

  // FONT_KEYS: the keys of a fonts[] entry per kind (site-config.mjs refuses the rest). A key
  // fonts.rs or fonts-fetch.mjs reads must be one of them.
  const fontBlock = siteText.match(/export const FONT_KEYS = Object\.freeze\(\{([\s\S]*?)\n\}\);/);
  if (!fontBlock) throw new Error(`${site}: FONT_KEYS not found; update scripts/api-surface.mjs`);
  const fontKinds = {};
  for (const m of fontBlock[1].matchAll(/(\w+): Object\.freeze\(\[([^\]]*)\]\)/g)) fontKinds[m[1]] = strings(m[2]);
  for (const k of ["common", "google", "local", "src"]) {
    if (!fontKinds[k]) throw new Error(`${site}: FONT_KEYS.${k} not found; update scripts/api-surface.mjs`);
  }
  const allFontKeys = new Set(Object.values(fontKinds).flat());
  const readKeys = new Set();
  for (const m of sourceText(root, fonts).matchAll(/(?:spec|e|f)\.get\("(\w+)"\)|str_of\("(\w+)"\)/g)) readKeys.add(m[1] ?? m[2]);
  for (const m of read(root, fontsFetch).matchAll(/\bspec\.(\w+)/g)) readKeys.add(m[1]);
  for (const k of readKeys) {
    if (!allFontKeys.has(k)) throw new Error(`font key ${k} is read but not in FONT_KEYS (${site}); update it`);
  }

  const hooks = new Set();
  for (const m of hostText.matchAll(/typeof p\.(\w+) === "function"/g)) hooks.add(m[1]);

  const files = [];
  for (const m of siteText.matchAll(/for \(const name of \[("nowaki\.config[^\]]*)\]\)/g)) {
    for (const f of m[1].matchAll(/"([^"]+)"/g)) files.push(f[1]);
  }
  if (!/mod\.default\b/.test(siteText)) throw new Error(`${site}: the default export read not found; update scripts/api-surface.mjs`);
  const exportsRead = ["default"];

  const out = [
    header([
      "nowaki.config keys: the top-level keys (site-config.mjs CONFIG_KEYS), the allowed keys of",
      "nested objects (site-config.mjs `keys()` calls), the keys of a fonts[] entry per kind",
      "(site-config.mjs FONT_KEYS) and the plugin hooks. An unknown key throws at every level.",
    ]),
    "[stable files]",
    ...files.map((f) => `${f}  # ${site}, ${host}`),
    ...[...new Set(exportsRead)].map((e) => `export ${e}  # the config object`),
    "",
    "[stable top-level]",
    ...[...top].sort(),
    "",
    "[stable nested]",
    ...[...byLabel.keys()].sort().map((l) => `${l}: ${byLabel.get(l).join(", ")}`),
    `trailingSlash: ${trailing[1].replace(/"/g, "").split(", ").join(" | ")}`,
    `fonts[]: ${fontKinds.common.join(", ")}`,
    `fonts[] (provider: "google"): ${fontKinds.google.join(", ")}`,
    `fonts[] (local, src): ${fontKinds.local.join(", ")}`,
    `fonts[].src[]: ${fontKinds.src.join(", ")}`,
    "",
    "[stable plugins]",
    ...[...hooks].sort().map((h) => `${h}  # plugins[].${h}`),
    "name  # plugins[].name (shown in errors)",
  ];
  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------------------------------------
// File conventions: each line comes from a probe in the code; a probe that stops matching fails
// generation, so a convention can't disappear without this file changing.

function probe(root, file, re, what) {
  const text = sourceText(root, file);
  const m = re.global ? [...text.matchAll(re)] : text.match(re);
  if (!m || (Array.isArray(m) && re.global && !m.length)) {
    throw new Error(`${file}: ${what} not found (${re}); update scripts/api-surface.mjs`);
  }
  return m;
}

const strings = (s) => [...s.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

export function genFiles(root) {
  const router = "packages/nowaki-runtime/server/router.mjs";
  const segments = "packages/nowaki-runtime/server/segments.mjs";
  const out = [
    header([
      "File conventions: the app files and names Nowaki gives a meaning to. Each line is taken",
      "from the code that implements it (the comment says where). .nowaki/ is internal, except",
      "the .nowaki/types.d.ts path.",
    ]),
    "[stable routes]",
  ];
  const ext = probe(root, router, /const ROUTE_EXT = \/\\\.\(([^)]+)\)\$\//, "ROUTE_EXT")[1].split("|");
  out.push(`routes/ file extensions: ${ext.map((e) => "." + e).join(" ")}  # ${router}`);
  probe(root, router, /urlPath\.endsWith\("\/index"\)/, "index");
  out.push(`routes/**/index  # ${router}`);
  probe(root, router, /urlRel\.startsWith\("api\/"\)/, "api/");
  out.push(`routes/api/** (API routes)  # ${router}`);
  probe(root, router, /nameExt = /, "file routes");
  out.push(`routes/**/<name>.<ext>.ts (file routes, e.g. feed.xml.ts)  # ${router}`);
  probe(root, segments, /\^\\\[\\\.\\\.\\\.\(\.\+\)\\\]\$/, "[...rest]");
  out.push(`[...rest] (catch-all segment)  # ${segments}`);
  probe(root, segments, /\^\\\[\(\[\^\\\]\.\]\+\)\\\]\(\\\.\[\^\/\]\+\)\$/, "[param].ext");
  out.push(`[param].<ext> (param with a fixed extension)  # ${segments}`);
  out.push(`[param]  # ${segments}`);
  const names = new Set(probe(root, router, /base === "(\w+)"/g, "convention names").map((m) => m[1]));
  names.delete("index");
  for (const name of names) {
    out.push(`routes/**/${name}${name === "default" ? " (slot fallback, @slot/default only)" : ""}  # ${router}`);
  }
  probe(root, router, /base\.startsWith\("_"\)\) continue; \/\/ reserved/, "reserved _*");
  out.push(`routes/**/_* (other names reserved)  # ${router}`);
  probe(root, router, /const GROUP_DIR = /, "GROUP_DIR");
  out.push(`routes/**/(group)/  # ${router}`);
  probe(root, router, /p\.startsWith\("@"\)/, "@slot");
  out.push(`routes/**/@slot/  # ${router}`);
  probe(root, router, /const INTERCEPT = \/\^\\\(\\\.\{1,3\}\\\)\//, "INTERCEPT");
  out.push(`(.)x (..)x (...)x intercepting segments inside a slot  # ${router}`);

  out.push("", "[stable app]");
  const lib = "crates/nowaki-core/src/lib.rs";
  probe(root, "crates/nowaki-core/src/build.rs", /core\.root\.join\("islands"\)/, "islands/");
  out.push("islands/  # crates/nowaki-core/src/build.rs");
  const content = probe(root, "crates/nowaki/src/content.rs", /root\.join\("content"\);\s*\n\s*\[([^\]]+)\]/, "content config")[1];
  out.push(`content/ with ${strings(content).map((f) => "content/" + f).join(" | ")}  # crates/nowaki/src/content.rs`);
  out.push("content/<collection>/  # crates/nowaki/src/content.rs");
  probe(root, "crates/nowaki-core/src/public.rs", /root\.join\("public"\)/, "public/");
  out.push("public/  # crates/nowaki-core/src/public.rs");
  const env = probe(root, "crates/nowaki-core/src/env.rs", /\[("env\.ts"[^\]]*)\]/, "env.ts")[1];
  out.push(`${strings(env).join(" | ")}  # crates/nowaki-core/src/env.rs`);
  const session = probe(root, "crates/nowaki-core/src/build.rs", /\[("session\.ts"[^\]]*)\]/, "session.ts")[1];
  out.push(`${strings(session).join(" | ")}  # crates/nowaki-core/src/build.rs`);
  const configs = probe(root, "packages/nowaki-runtime/server/site-config.mjs", /for \(const name of \[("nowaki\.config[^\]]*)\]\)/, "nowaki.config")[1];
  out.push(`${strings(configs).join(" | ")}  # packages/nowaki-runtime/server/site-config.mjs`);
  const dotenv = probe(root, "packages/nowaki-runtime/server/env.mjs", /for \(const file of \[(".env"[^\]]*)\]\)/, ".env files")[1];
  out.push(`${strings(dotenv).join(" | ")} (loaded into process.env, never overriding it)  # packages/nowaki-runtime/server/env.mjs`);
  probe(root, "crates/nowaki/src/typegen.rs", /out_dir\.join\("types\.d\.ts"\)/, ".nowaki/types.d.ts");
  out.push(".nowaki/types.d.ts (typegen output)  # crates/nowaki/src/typegen.rs");
  const sources = probe(root, lib, /Some\(("ts" \| "tsx"[^)]*)\)/, "source extensions")[1];
  out.push(`source extensions: ${strings(sources).map((e) => "." + e).join(" ")}  # ${lib}`);
  probe(root, "crates/nowaki/src/plugins.rs", /fn compile_tsrx/, ".tsrx");
  out.push(".tsrx (compiled with the app's @tsrx/preact)  # crates/nowaki/src/plugins.rs");
  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------------------------------------
// create-nowaki flags and templates

export function genCreateNowaki(root) {
  const file = "packages/create-nowaki/index.js";
  const text = read(root, file);
  const flags = new Set();
  for (const m of text.matchAll(/flags\.has\("(-[-\w]+)"\)/g)) flags.add(m[1]);
  const values = strings(probe(root, file, /const VALUE_FLAGS = new Set\(\[([^\]]*)\]\)/, "VALUE_FLAGS")[1]);
  for (const v of values) flags.add(`${v} <value>`);
  const templates = readdirSync(path.join(root, "packages/create-nowaki/templates"))
    .filter((d) => !d.startsWith("_") && statSync(path.join(root, "packages/create-nowaki/templates", d)).isDirectory())
    .sort();
  const pms = text.match(/--pm <([^>]+)>/);
  return [
    header(["create-nowaki / create-nowaki-app: command-line flags (from index.js) and template names."]),
    "[stable flags]",
    ...[...flags].sort(),
    "<dir>",
    "",
    "[stable templates]",
    ...templates,
    ...(pms ? ["", "[stable package managers]", ...pms[1].split("|")] : []),
  ].join("\n") + "\n";
}

// ---------------------------------------------------------------------------------------------

export const SNAPSHOTS = [
  { file: "runtime.d.ts.txt", gen: genRuntime },
  { file: "markdoc.d.ts.txt", gen: genMarkdoc },
  { file: "template-types.d.ts.txt", gen: genTemplateTypes },
  { file: "route-exports.txt", gen: genRouteExports },
  { file: "files.txt", gen: genFiles },
  { file: "config.txt", gen: genConfig },
  { file: "create-nowaki.txt", gen: genCreateNowaki },
  { file: "env.txt", gen: genEnv },
  { file: "http.txt", gen: genHttp },
  { file: "client.txt", gen: genClient },
];
/// Written by the main.rs unit test, compared by the --base check like the others.
export const CARGO_SNAPSHOTS = ["cli.txt"];

/// Generate every snapshot: [{ file, text, current }].
export function generateAll(root = REPO) {
  return SNAPSHOTS.map(({ file, gen }) => {
    const p = path.join(root, "api", file);
    const current = existsSync(p) ? normalize(readFileSync(p, "utf8")) : "";
    return { file, text: gen(root, current), current };
  });
}

export const unclassified = (text) => parseSnapshot(text).filter((e) => e.startsWith("[unclassified]"));

function workspaceVersion(root) {
  const m = read(root, "Cargo.toml").match(/\[workspace\.package\][^[]*?\nversion = "([^"]+)"/);
  if (!m) throw new Error("Cargo.toml: [workspace.package] version not found");
  return m[1];
}

function gitShow(root, ref, file) {
  const r = spawnSync("git", ["show", `${ref}:${file}`], { cwd: root, encoding: "utf8" });
  return r.status === 0 ? normalize(r.stdout) : null;
}

function ensureCommit(root, ref) {
  if (spawnSync("git", ["cat-file", "-e", `${ref}^{commit}`], { cwd: root }).status === 0) return;
  execFileSync("git", ["fetch", "--no-tags", "--depth=1", "origin", ref], { cwd: root, stdio: "inherit" });
}

/// Labels of the pull request this CI run is for, read live from the API when a token is given
/// (so adding the label and re-running the job works), else from the event payload.
async function prLabels(event) {
  const pr = event?.pull_request;
  if (!pr) return [];
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (token && repo) {
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${pr.number}`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "nowaki-api-surface" },
      });
      if (res.ok) return ((await res.json()).labels ?? []).map((l) => l.name);
      console.warn(`api-surface: GET pulls/${pr.number} answered ${res.status}; using the event's labels`);
    } catch (e) {
      console.warn(`api-surface: label lookup failed (${e?.message ?? e}); using the event's labels`);
    }
  }
  return (pr.labels ?? []).map((l) => l.name);
}

/// Stable entries removed or changed between `base` and the working tree, per file.
export function compareWithBase(root, base) {
  const files = [...SNAPSHOTS.map((s) => s.file), ...CARGO_SNAPSHOTS];
  const baseList = spawnSync("git", ["ls-tree", "--name-only", `${base}:api`], { cwd: root, encoding: "utf8" });
  if (baseList.status === 0) for (const f of baseList.stdout.split("\n")) if (f.endsWith(".txt") && !files.includes(f)) files.push(f);
  const out = [];
  for (const file of files.sort()) {
    const before = gitShow(root, base, `api/${file}`);
    if (before === null) continue;
    const p = path.join(root, "api", file);
    const after = existsSync(p) ? normalize(readFileSync(p, "utf8")) : "";
    const removed = removedEntries(before, after);
    const added = addedEntries(before, after);
    if (removed.length || added.length) out.push({ file, removed, added });
  }
  return out;
}

function showEntry(e) {
  const [section, text] = e.split("\t");
  return `${section} ${text}`;
}

async function main(argv) {
  const check = argv.includes("--check");
  const noCargo = argv.includes("--no-cargo");
  const baseAt = argv.indexOf("--base");
  let base = baseAt === -1 ? null : argv[baseAt + 1];
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const event = eventPath && existsSync(eventPath) ? JSON.parse(readFileSync(eventPath, "utf8")) : null;
  if (!base && event?.pull_request) base = event.pull_request.base.sha;

  let failed = false;
  const results = generateAll(REPO);
  if (check) {
    const stale = results.filter((r) => r.text !== r.current).map((r) => r.file);
    if (stale.length) {
      failed = true;
      console.error(`api-surface: out of date: ${stale.map((f) => "api/" + f).join(", ")}`);
      console.error("Run `node scripts/api-surface.mjs`, review the diff and commit it (CONTRIBUTING.md > API snapshots).");
      for (const r of results.filter((x) => x.text !== x.current)) printDiff(r.file, r.current, r.text);
    }
  } else {
    mkdirSync(path.join(REPO, "api"), { recursive: true });
    for (const r of results) {
      if (r.text !== r.current) {
        writeFileSync(path.join(REPO, "api", r.file), r.text);
        console.log(`wrote api/${r.file}`);
      }
    }
    if (!noCargo) {
      const run = spawnSync("cargo", ["test", "-q", "-p", "nowaki", "--bin", "nowaki", "cli_surface"], {
        cwd: REPO,
        stdio: "inherit",
        env: { ...process.env, NOWAKI_UPDATE_SNAPSHOTS: "1" },
      });
      if (run.status !== 0) {
        console.error("api-surface: `cargo test -p nowaki --bin nowaki cli_surface` failed (api/cli.txt not updated)");
        failed = true;
      }
    }
  }
  for (const r of results) {
    const open = unclassified(r.text);
    if (!open.length) continue;
    failed = true;
    console.error(`api-surface: api/${r.file} has unclassified names; move each to a section ([stable], [dev], [internal], ...):`);
    for (const e of open) console.error("  " + e.split("\t")[1]);
  }

  if (base) {
    ensureCommit(REPO, base);
    const version = workspaceVersion(REPO);
    const frozen = versionAtLeast(version, FREEZE_VERSION);
    const changes = compareWithBase(REPO, base);
    const removed = changes.flatMap((c) => c.removed.map((e) => `api/${c.file}: ${showEntry(e)}`));
    const added = changes.flatMap((c) => c.added.map((e) => `api/${c.file}: ${showEntry(e)}`));
    if (added.length) {
      console.log(`api-surface: ${added.length} stable entr${added.length === 1 ? "y" : "ies"} added since ${base} (add a CHANGELOG line):`);
      for (const a of added) console.log("  + " + a);
    }
    if (removed.length) {
      const labels = await prLabels(event);
      const allowed = labels.includes(BREAKING_LABEL);
      const lead = `api-surface: ${removed.length} stable entr${removed.length === 1 ? "y" : "ies"} removed or changed since ${base}`;
      console.log(`${lead}:`);
      for (const r of removed) console.log("  - " + r);
      if (!frozen) {
        console.log(`(allowed: the API freeze starts at ${FREEZE_VERSION}; the workspace is at ${version})`);
      } else if (allowed) {
        console.log(`(allowed: the PR has the \`${BREAKING_LABEL}\` label)`);
      } else {
        failed = true;
        console.error(
          `api-surface: removing or changing a stable entry breaks semver. Add the \`${BREAKING_LABEL}\` label ` +
            "(a change for the next major) and re-run this job, or keep the old entry working.",
        );
      }
    }
    if (!added.length && !removed.length) console.log(`api-surface: no stable entries changed since ${base}`);
  }
  if (failed) process.exit(1);
  if (check) console.log(`api-surface: OK (${results.length} snapshots up to date)`);
}

function printDiff(file, before, after) {
  const a = new Set(before.split("\n"));
  const b = new Set(after.split("\n"));
  console.error(`--- api/${file} (checked in)\n+++ api/${file} (generated)`);
  for (const l of before.split("\n")) if (!b.has(l)) console.error(`- ${l}`);
  for (const l of after.split("\n")) if (!a.has(l)) console.error(`+ ${l}`);
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entry) await main(process.argv.slice(2));
