// Frontmatter for `.mdoc` modules: the fence split (same rules as Nowaki's Rust `split_frontmatter`)
// and a small parser for flat YAML / TOML (scalars, lists of scalars). Anything richer is an error
// that names the `parseFrontmatter` option, so a value is never silently read wrong. Content
// collections don't use this: Nowaki reads an entry's frontmatter in Rust.

// -> { format: "yaml" | "toml" | null, raw, body, lines } where `lines` is how many source lines
// the frontmatter (with its fences) took.
export function splitFrontmatter(src) {
  const s = src.startsWith("﻿") ? src.slice(1) : src;
  const nl = s.indexOf("\n");
  if (nl < 0) return { format: null, raw: "", body: s, lines: 0 };
  const fence = s.slice(0, nl).replace(/\r$/, "");
  if (fence !== "---" && fence !== "+++") return { format: null, raw: "", body: s, lines: 0 };
  const rest = s.slice(nl + 1);
  let offset = 0;
  let lines = 1;
  while (offset <= rest.length) {
    const end = rest.indexOf("\n", offset);
    const line = end < 0 ? rest.slice(offset) : rest.slice(offset, end + 1);
    if (line === "") break;
    lines++;
    if (line.replace(/[\r\n]+$/, "") === fence) {
      return {
        format: fence === "---" ? "yaml" : "toml",
        raw: rest.slice(0, offset),
        body: rest.slice(offset + line.length),
        lines,
      };
    }
    offset += line.length;
  }
  return { format: null, raw: "", body: s, lines: 0 };
}

function unsupported(format, line) {
  return new Error(
    `frontmatter: the built-in ${format.toUpperCase()} reader handles flat \`key${format === "yaml" ? ":" : " ="} value\` pairs and lists of scalars; ` +
      `line ${JSON.stringify(line.trim())} needs a full parser (pass \`parseFrontmatter\` to markdoc())`,
  );
}

function unquote(v, format, line) {
  if (v.startsWith('"')) {
    if (!v.endsWith('"') || v.length < 2) throw unsupported(format, line);
    return JSON.parse(v);
  }
  if (v.startsWith("'")) {
    if (!v.endsWith("'") || v.length < 2) throw unsupported(format, line);
    const inner = v.slice(1, -1);
    return format === "yaml" ? inner.replaceAll("''", "'") : inner;
  }
  return undefined;
}

function yamlScalar(raw, line) {
  const v = raw.replace(/\s+#.*$/, "").trim();
  const q = unquote(v, "yaml", line);
  if (q !== undefined) return q;
  if (v === "" || v === "~" || v === "null" || v === "Null" || v === "NULL") return null;
  if (/^(true|True|TRUE)$/.test(v)) return true;
  if (/^(false|False|FALSE)$/.test(v)) return false;
  if (/^[-+]?(\d+|\d*\.\d+)([eE][-+]?\d+)?$/.test(v)) return Number(v);
  if (/^[[{|>&*!%@`]/.test(v)) throw unsupported("yaml", line);
  return v;
}

function yamlFlowList(raw, line) {
  const v = raw.replace(/\s+#.*$/, "").trim();
  if (!v.endsWith("]")) throw unsupported("yaml", line);
  const inner = v.slice(1, -1).trim();
  if (inner === "") return [];
  if (/[[\]{}]/.test(inner)) throw unsupported("yaml", line);
  return splitList(inner, "yaml", line).map((item) => yamlScalar(item, line));
}

function splitList(inner, format, line) {
  const items = [];
  let cur = "";
  let quote = null;
  for (const ch of inner) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ",") {
      items.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (quote) throw unsupported(format, line);
  if (cur.trim() !== "") items.push(cur.trim());
  return items;
}

export function parseYaml(raw) {
  const out = {};
  // The last `key:` with nothing after it: `- item` lines below it make it a list (else it's null).
  let listKey = null;
  for (const line of raw.split(/\r?\n/)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    const item = /^\s*-(?:\s+(.*))?$/.exec(line);
    if (item && listKey !== null) {
      const v = item[1] ?? "";
      if (/^[[{]/.test(v.trim()) || /^[^'"]*:(\s|$)/.test(v)) throw unsupported("yaml", line);
      (out[listKey] ??= []).push(yamlScalar(v, line));
      continue;
    }
    const m = /^([A-Za-z_][\w-]*|"[^"]*"|'[^']*'):(?:\s+(.*))?$/.exec(line);
    if (!m) throw unsupported("yaml", line);
    const key = unquote(m[1], "yaml", line) ?? m[1];
    if (Object.prototype.hasOwnProperty.call(out, key)) throw new Error(`frontmatter: duplicate key ${JSON.stringify(key)}`);
    const value = (m[2] ?? "").replace(/^\s*#.*$/, "");
    listKey = null;
    if (value.trim() === "") {
      out[key] = null;
      listKey = key;
    } else if (value.trim().startsWith("[")) {
      out[key] = yamlFlowList(value, line);
    } else {
      out[key] = yamlScalar(value, line);
    }
  }
  return out;
}

function tomlScalar(raw, line) {
  const v = raw.trim();
  const q = unquote(v, "toml", line);
  if (q !== undefined) return q;
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^[-+]?(0|[1-9](_?\d)*)$/.test(v)) return Number(v.replaceAll("_", ""));
  if (/^[-+]?(0|[1-9](_?\d)*)(\.\d(_?\d)*)?([eE][-+]?\d+)?$/.test(v)) return Number(v.replaceAll("_", ""));
  if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[-+]\d{2}:\d{2})?)?$/.test(v)) return v.replace(" ", "T");
  if (/^\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(v)) return v;
  throw unsupported("toml", line);
}

function stripTomlComment(v) {
  let quote = null;
  for (let i = 0; i < v.length; i++) {
    const ch = v[i];
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#") return v.slice(0, i);
  }
  return v;
}

export function parseToml(raw) {
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    const m = /^\s*([A-Za-z0-9_-]+|"[^"]*"|'[^']*')\s*=\s*(.*)$/.exec(line);
    if (!m) throw unsupported("toml", line);
    const key = unquote(m[1], "toml", line) ?? m[1];
    if (Object.prototype.hasOwnProperty.call(out, key)) throw new Error(`frontmatter: duplicate key ${JSON.stringify(key)}`);
    const value = stripTomlComment(m[2]).trim();
    if (value.startsWith('"""') || value.startsWith("'''") || value.startsWith("{")) throw unsupported("toml", line);
    if (value.startsWith("[")) {
      if (!value.endsWith("]")) throw unsupported("toml", line);
      const inner = value.slice(1, -1).trim();
      if (/[[\]{}]/.test(inner)) throw unsupported("toml", line);
      out[key] = inner === "" ? [] : splitList(inner, "toml", line).map((item) => tomlScalar(item, line));
    } else {
      out[key] = tomlScalar(value, line);
    }
  }
  return out;
}
