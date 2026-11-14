//! The readiness report of `nowaki upgrade --to <version>` when the version is on a newer major
//! (or 0.x minor) than the app: what in the app has to change before the upgrade, with file:line
//! and the fix. Read-only: it reads files and runs `node --version` / `rustc --version`, and
//! never writes. No codemods.
//!
//! The checks follow the 0.20.0 / 1.0 Upgrade notes in CHANGELOG.md: the removed aliases
//! (`_error.tsx`, `export const middleware`, `export const config`, lowercase API method
//! exports), unknown top-level `nowaki.config` keys, `--host <dir>` in package.json scripts, and
//! version / engine requirements are "must change"; `ctx.formData()` results used as
//! `URLSearchParams`, API routes that may need `csrf = false`, and `PORT` in the environment are
//! heuristics to review.

use std::path::{Path, PathBuf};

use crate::runtime::Version;

/// Top-level `nowaki.config` keys (`server/site-config.mjs` and `server/plugin-host.mjs`).
pub const CONFIG_KEYS: &[&str] = &[
    "site",
    "fonts",
    "basePath",
    "trailingSlash",
    "redirects",
    "rewrites",
    "headers",
    "i18n",
    "images",
    "plugins",
];

/// The oldest Node line the runtime supports (`engines.node` in its package.json).
pub const MIN_NODE: u64 = 22;

const METHODS: &[&str] = &["get", "post", "put", "patch", "delete", "head", "options"];
const WRITE_METHODS: &[&str] = &["post", "put", "patch", "delete"];
const CODE_EXTS: &[&str] = &["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "mdx"];
const SKIP_DIRS: &[&str] = &["node_modules", "dist", "public", "target"];
const MAX_FILE: u64 = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    /// Fails or behaves differently after the upgrade.
    Must,
    /// A heuristic: review it.
    Check,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    pub level: Level,
    /// Relative to the app root, `/`-separated; `None` for the environment.
    pub file: Option<String>,
    pub line: Option<usize>,
    pub what: String,
    pub fix: String,
}

impl Finding {
    fn at(level: Level, file: &str, line: usize, what: String, fix: String) -> Self {
        Finding {
            level,
            file: Some(file.to_string()),
            line: Some(line),
            what,
            fix,
        }
    }

    pub fn location(&self) -> String {
        match (&self.file, self.line) {
            (Some(f), Some(l)) => format!("{f}:{l}"),
            (Some(f), None) => f.clone(),
            _ => "environment".to_string(),
        }
    }
}

/// What the report knows about the machine and the app's packages; gathered by [`Facts::read`],
/// passed in by tests.
#[derive(Debug, Default, Clone)]
pub struct Facts {
    /// `node --version`, without the `v`.
    pub node: Option<String>,
    /// `rustc --version`'s version.
    pub rustc: Option<String>,
    /// `PORT` in this shell.
    pub port_env: Option<String>,
    /// The `nowaki` / `@nowaki-dev/runtime` versions in node_modules.
    pub cli_installed: Option<String>,
    pub runtime_installed: Option<String>,
    /// The app's current version: the installed runtime, else its package.json range.
    pub current: Option<Version>,
}

impl Facts {
    pub fn read(root: &Path, runtime_range: Option<&str>) -> Facts {
        let runtime_installed = crate::runtime::installed_version(root, "@nowaki-dev/runtime")
            .ok()
            .flatten();
        let current = runtime_installed
            .as_deref()
            .and_then(Version::parse)
            .or_else(|| runtime_range.and_then(range_version));
        Facts {
            node: command_version("node", &["--version"]),
            rustc: command_version("rustc", &["--version"]),
            port_env: std::env::var("PORT").ok().filter(|v| !v.trim().is_empty()),
            cli_installed: crate::runtime::installed_version(root, "nowaki")
                .ok()
                .flatten(),
            runtime_installed,
            current,
        }
    }
}

/// The version a range like `^0.19.3`, `~0.19.3`, `>=0.19.3` or `0.19.3` starts at.
pub fn range_version(range: &str) -> Option<Version> {
    let r = range.trim().trim_start_matches(['^', '~', '>', '=', ' ']);
    let first = r.split_whitespace().next()?;
    // `>=18` / `>=18.1` mean 18.0.0 / 18.1.0.
    let padded = match first.matches('.').count() {
        0 if !first.contains('-') => format!("{first}.0.0"),
        1 if !first.contains('-') => format!("{first}.0"),
        _ => first.to_string(),
    };
    Version::parse(&padded)
}

/// The first `x.y.z` in a `--version` line (`v22.11.0`, `rustc 1.97.0 (… )`).
fn command_version(prog: &str, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new(prog).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    first_version(&String::from_utf8_lossy(&out.stdout))
}

fn first_version(text: &str) -> Option<String> {
    text.split_whitespace()
        .map(|w| w.trim_start_matches('v'))
        .find(|w| Version::parse(w).is_some())
        .map(str::to_string)
}

/// Every check, sorted by level, then file and line.
pub fn scan(root: &Path, pkg: &serde_json::Value, facts: &Facts) -> Vec<Finding> {
    let mut out = Vec::new();
    for (rel, path) in code_files(root) {
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        scan_source(&rel, &text, facts, &mut out);
    }
    for name in ["nowaki.config.mjs", "nowaki.config.js"] {
        if let Ok(text) = std::fs::read_to_string(root.join(name)) {
            scan_config(name, &text, &mut out);
            break; // the first one is the one the runtime loads
        }
    }
    scan_package_json(root, pkg, &mut out);
    scan_env_files(root, &mut out);
    scan_facts(pkg, facts, &mut out);
    out.sort_by(|a, b| {
        let level = |f: &Finding| f.level == Level::Check;
        (level(a), a.file.is_none(), &a.file, a.line).cmp(&(
            level(b),
            b.file.is_none(),
            &b.file,
            b.line,
        ))
    });
    out
}

/// App source files (`/`-separated paths relative to the root), skipping dependencies, build
/// output and dot directories.
fn code_files(root: &Path) -> Vec<(String, PathBuf)> {
    fn walk(dir: &Path, rel: &str, out: &mut Vec<(String, PathBuf)>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let name = e.file_name().to_string_lossy().into_owned();
            let Ok(ft) = e.file_type() else { continue };
            let child = if rel.is_empty() {
                name.clone()
            } else {
                format!("{rel}/{name}")
            };
            if ft.is_dir() {
                if name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()) {
                    continue;
                }
                walk(&e.path(), &child, out);
            } else if ft.is_file() {
                let ext = name.rsplit('.').next().unwrap_or("");
                let small = e.metadata().map(|m| m.len() <= MAX_FILE).unwrap_or(false);
                if name.contains('.') && CODE_EXTS.contains(&ext) && small {
                    out.push((child, e.path()));
                }
            }
        }
    }
    let mut out = Vec::new();
    walk(root, "", &mut out);
    out
}

/// `routes/(shop)/api/x.ts` → `api/x.ts` (route groups don't add a segment).
fn route_rel(rel: &str) -> Option<String> {
    let rest = rel.strip_prefix("routes/")?;
    Some(
        rest.split('/')
            .filter(|s| !(s.starts_with('(') && s.ends_with(')')))
            .collect::<Vec<_>>()
            .join("/"),
    )
}

/// The file name without its extension (`_middleware.ts` → `_middleware`, `feed.xml.ts` →
/// `feed.xml`).
fn stem(rel: &str) -> &str {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    name.rsplit_once('.').map(|(s, _)| s).unwrap_or(name)
}

fn scan_source(rel: &str, text: &str, facts: &Facts, out: &mut Vec<Finding>) {
    let route = route_rel(rel);
    let name = stem(rel);
    let lines: Vec<&str> = text.lines().collect();

    if let Some(route) = &route {
        if name == "_error" {
            let ext = rel.rsplit('.').next().unwrap_or("tsx");
            let to = format!(
                "{}_500.{ext}",
                &rel[..rel.len() - name.len() - ext.len() - 1]
            );
            out.push(Finding::at(
                Level::Must,
                rel,
                1,
                "`_error` is no longer the 500 page (0.20.0 removed the alias; `error.tsx` is the client navigation boundary)".into(),
                format!("Rename it to `{to}`."),
            ));
        }
        let is_api = route.starts_with("api/") || stem(route).contains('.');
        let mut write_handler = None;
        let mut has_csrf = false;
        for (i, line) in lines.iter().enumerate() {
            let Some(export) = exported_name(line) else {
                continue;
            };
            if name == "_middleware" && export == "middleware" {
                out.push(Finding::at(
                    Level::Must,
                    rel,
                    i + 1,
                    "`export const middleware` is no longer read (0.20.0 removed the alias)".into(),
                    "Make it the default export: `export default async function middleware(ctx) { … }`.".into(),
                ));
            }
            if export == "csrf" {
                has_csrf = true;
            }
            let lower = export.to_ascii_lowercase();
            if WRITE_METHODS.contains(&lower.as_str()) && write_handler.is_none() {
                write_handler = Some((i + 1, export.to_ascii_uppercase()));
            }
            // API and file routes only: a page's `export const head` is its document head.
            if is_api && METHODS.contains(&export) {
                out.push(Finding::at(
                    Level::Must,
                    rel,
                    i + 1,
                    format!("lowercase method export `{export}` (0.20.0 dispatches only the uppercase names)"),
                    format!("Rename it to `{}`.", export.to_ascii_uppercase()),
                ));
            }
        }
        // API routes reject cross-site writes since 0.19.3; an app from before that may rely on them.
        let before_csrf = facts
            .current
            .as_ref()
            .is_none_or(|v| v < &Version::parse("0.19.3").unwrap());
        if let (true, Some((line, method)), false, true) =
            (is_api, write_handler, has_csrf, before_csrf)
        {
            out.push(Finding::at(
                Level::Check,
                rel,
                line,
                format!("API route with a {method} handler and no `export const csrf`: since 0.19.3 a {method} from another site's page is rejected with 403"),
                "If browsers on other sites call it (a webhook or callback is usually server-to-server and is not affected), add `export const csrf = false` and authenticate it another way.".into(),
            ));
        }
    }

    if text.contains("formData()") {
        form_data_uses(rel, &lines, out);
    }
}

/// The name an `export` line declares: `export const x`, `export async function x`, …
fn exported_name(line: &str) -> Option<&str> {
    let mut rest = line.trim_start().strip_prefix("export")?;
    if !rest.starts_with(char::is_whitespace) {
        return None;
    }
    rest = rest.trim_start();
    for kw in [
        "async ",
        "const ",
        "let ",
        "var ",
        "function* ",
        "function ",
    ] {
        if let Some(r) = rest.strip_prefix(kw) {
            rest = r.trim_start();
            if kw == "async " {
                rest = rest
                    .strip_prefix("function")?
                    .trim_start_matches('*')
                    .trim_start();
            }
            let end = rest
                .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '$'))
                .unwrap_or(rest.len());
            return (end > 0).then(|| &rest[..end]);
        }
    }
    None
}

fn is_ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'$'
}

/// Byte offsets where `needle` starts with no identifier character (or `.`) right before it.
fn word_at(hay: &str, needle: &str) -> Vec<usize> {
    let mut out = Vec::new();
    let b = hay.as_bytes();
    let mut from = 0;
    while let Some(i) = hay[from..].find(needle) {
        let at = from + i;
        if at == 0 || !(is_ident_byte(b[at - 1]) || b[at - 1] == b'.') {
            out.push(at);
        }
        from = at + needle.len();
    }
    out
}

/// `ctx.formData()` returns `FormData` since 0.20.0 (it was `URLSearchParams` for urlencoded
/// bodies). Flags the result used in ways only `URLSearchParams` supports, and `.get()` results
/// used as strings (they are `string | File | null` now).
fn form_data_uses(rel: &str, lines: &[&str], out: &mut Vec<Finding>) {
    // `const form = await ctx.formData()` (any receiver).
    let mut names = Vec::new();
    for line in lines {
        let t = line.trim_start();
        for kw in ["const ", "let ", "var "] {
            let Some(r) = t.strip_prefix(kw) else {
                continue;
            };
            let end = r.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '$'));
            let Some(end) = end.filter(|&e| e > 0) else {
                continue;
            };
            let after = r[end..].trim_start();
            if after.starts_with('=') && after.contains("formData()") {
                names.push(r[..end].to_string());
            }
        }
    }
    let mut seen = std::collections::BTreeSet::new();
    let mut flag = |line: usize, what: String, out: &mut Vec<Finding>| {
        if seen.insert(line) {
            out.push(Finding::at(
                Level::Check,
                rel,
                line,
                what,
                "`ctx.formData()` returns `FormData` since 0.20.0: read text with `String(form.get(\"x\") ?? \"\")`, and build a query string with `new URLSearchParams([...form].filter(([, v]) => typeof v === \"string\"))`.".into(),
            ));
        }
    };
    for (i, line) in lines.iter().enumerate() {
        for m in [
            "formData()).toString(",
            "formData()).sort(",
            "formData()).size",
        ] {
            if line.contains(m) {
                flag(
                    i + 1,
                    format!("`formData()` result used with `{}` (heuristic)", &m[12..]),
                    out,
                );
            }
        }
        for name in &names {
            let only = [".toString(", ".sort(", ".size"];
            for at in word_at(line, name) {
                let rest = &line[at + name.len()..];
                if let Some(m) = only.iter().find(|m| rest.starts_with(*m)) {
                    flag(
                        i + 1,
                        format!("`{name}{m}` exists only on `URLSearchParams` (heuristic)"),
                        out,
                    );
                } else if rest.starts_with(".get(") {
                    // `.get(...)` chained into a string method: `form.get("q").trim()`.
                    let close = matching_paren(rest, 4);
                    let after = close.map(|c| rest[c + 1..].trim_start()).unwrap_or("");
                    let chained = after.starts_with('.') && !after.starts_with("..")
                        || after.starts_with("?.");
                    if chained {
                        flag(i + 1, format!("`{name}.get(…)` used as a string; it is `string | File | null` now (heuristic)"), out);
                    }
                }
            }
            for wrap in [
                format!("String({name})"),
                format!("${{{name}}}"),
                format!("URLSearchParams({name})"),
            ] {
                if line.contains(&wrap) {
                    flag(
                        i + 1,
                        format!("`{wrap}` relies on `URLSearchParams` (heuristic)"),
                        out,
                    );
                }
            }
        }
    }
}

/// The index of the `)` matching the `(` at `open`.
fn matching_paren(s: &str, open: usize) -> Option<usize> {
    let mut depth = 0usize;
    for (i, c) in s.char_indices().skip_while(|(i, _)| *i < open) {
        match c {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

fn line_of(text: &str, offset: usize) -> usize {
    text[..offset.min(text.len())].matches('\n').count() + 1
}

fn scan_config(name: &str, text: &str, out: &mut Vec<Finding>) {
    for (i, line) in text.lines().enumerate() {
        if exported_name(line) == Some("config") {
            out.push(Finding::at(
                Level::Must,
                name,
                i + 1,
                "`export const config` is no longer read (0.20.0 removed the alias)".into(),
                "Export the config as the default: `export default { … }`.".into(),
            ));
        }
    }
    let Some(keys) = config_keys(text) else {
        return;
    };
    for (key, offset) in keys {
        if CONFIG_KEYS.contains(&key.as_str()) {
            continue;
        }
        let hint = CONFIG_KEYS
            .iter()
            .find(|k| k.eq_ignore_ascii_case(&key))
            .map(|k| format!("Did you mean `{k}`? "))
            .unwrap_or_default();
        out.push(Finding::at(
            Level::Must,
            name,
            line_of(text, offset),
            format!("unknown top-level key `{key}` (ignored before 0.20.0, an error since)"),
            format!(
                "{hint}Remove it or rename it; the keys are {}.",
                CONFIG_KEYS.join(", ")
            ),
        ));
    }
}

/// The top-level keys (and their byte offsets) of the object `nowaki.config` exports: `export
/// default { … }`, `export default defineConfig({ … })`, `export default name` with `const name =
/// { … }`, or `export const config = { … }`. `None` when it is built some other way.
fn config_keys(text: &str) -> Option<Vec<(String, usize)>> {
    let code = blank_comments_and_strings(text);
    let object_after = |at: usize| -> Option<usize> {
        let rest = &code[at..];
        let trimmed = rest.trim_start();
        let mut i = at + (rest.len() - trimmed.len());
        if let Some(r) = trimmed.strip_prefix("defineConfig") {
            let r2 = r.trim_start();
            if !r2.starts_with('(') {
                return None;
            }
            i += "defineConfig".len() + (r.len() - r2.len()) + 1;
            let r3 = &code[i..];
            i += r3.len() - r3.trim_start().len();
        }
        code[i..].starts_with('{').then_some(i)
    };
    let start = if let Some(at) = code.find("export default") {
        let after = at + "export default".len();
        object_after(after).or_else(|| {
            // `export default name`: the object `name` is assigned.
            let rest = code[after..].trim_start();
            let end = rest.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '$'))?;
            let ident = &rest[..end];
            if ident.is_empty() {
                return None;
            }
            ["const ", "let ", "var "].iter().find_map(|kw| {
                let decl = format!("{kw}{ident}");
                let at = word_at(&code, &decl).into_iter().next()?;
                let eq = code[at..].find('=')? + at + 1;
                object_after(eq)
            })
        })
    } else {
        let at = word_at(&code, "export const config").into_iter().next()?;
        let eq = code[at..].find('=')? + at + 1;
        object_after(eq)
    }?;
    Some(object_keys(&code, text, start))
}

/// The keys of the object literal starting at `code[start] == '{'`. `code` is `text` with comments
/// and string contents blanked (same offsets), so only real braces count; key names are read from
/// `text` (a quoted key is blanked in `code`).
fn object_keys(code: &str, text: &str, start: usize) -> Vec<(String, usize)> {
    let b = code.as_bytes();
    let mut keys = Vec::new();
    let mut depth = 0usize;
    let mut expect_key = false;
    let mut i = start;
    while i < b.len() {
        let c = b[i];
        if depth == 1 && expect_key && !c.is_ascii_whitespace() {
            expect_key = false;
            if c == b'"' || c == b'\'' {
                if let Some(len) = text[i + 1..].find(c as char) {
                    keys.push((text[i + 1..i + 1 + len].to_string(), i));
                    i += len + 2;
                    continue;
                }
            } else if is_ident_byte(c) {
                let end = code[i..]
                    .find(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_' || ch == '$'))
                    .map(|e| i + e)
                    .unwrap_or(b.len());
                let mut word = &code[i..end];
                let mut at = i;
                // `async name()` / `get name()` methods.
                if matches!(word, "async" | "get" | "set") {
                    let rest = &code[end..];
                    let next = rest.trim_start();
                    if next.starts_with(|ch: char| ch.is_ascii_alphabetic() || ch == '_') {
                        at = end + (rest.len() - next.len());
                        let e2 = next
                            .find(|ch: char| {
                                !(ch.is_ascii_alphanumeric() || ch == '_' || ch == '$')
                            })
                            .unwrap_or(next.len());
                        word = &next[..e2];
                    }
                }
                keys.push((word.to_string(), at));
                i = end;
                continue;
            }
            // `...spread`, `[computed]`: not a plain key.
        }
        match c {
            b'{' | b'[' | b'(' => {
                depth += 1;
                if depth == 1 {
                    expect_key = true;
                }
            }
            b'}' | b']' | b')' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    break;
                }
            }
            b',' if depth == 1 => expect_key = true,
            _ => {}
        }
        i += 1;
    }
    keys
}

/// `text` with comments replaced by spaces and the contents of strings and template literals
/// replaced by `_` (the quotes stay), keeping every byte offset.
fn blank_comments_and_strings(text: &str) -> String {
    let b = text.as_bytes();
    let mut out = b.to_vec();
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'/' if b.get(i + 1) == Some(&b'/') => {
                while i < b.len() && b[i] != b'\n' {
                    out[i] = b' ';
                    i += 1;
                }
            }
            b'/' if b.get(i + 1) == Some(&b'*') => {
                let end = text[i + 2..]
                    .find("*/")
                    .map(|e| i + 2 + e + 2)
                    .unwrap_or(b.len());
                for o in out.iter_mut().take(end).skip(i) {
                    if *o != b'\n' {
                        *o = b' ';
                    }
                }
                i = end;
            }
            q @ (b'"' | b'\'' | b'`') => {
                i += 1;
                while i < b.len() && b[i] != q {
                    if b[i] == b'\\' && i + 1 < b.len() {
                        out[i] = b'_';
                        i += 1;
                    }
                    if b[i] != b'\n' {
                        out[i] = b'_';
                    }
                    i += 1;
                }
                i += 1;
            }
            _ => i += 1,
        }
    }
    // Only ASCII bytes were replaced, and whole multi-byte characters inside strings and
    // comments became `_` / ` ` byte by byte, so the result is valid UTF-8.
    String::from_utf8(out).unwrap_or_default()
}

/// `--host <dir>` in package.json scripts (`--host` takes an optional address since 0.20.0).
fn scan_package_json(root: &Path, pkg: &serde_json::Value, out: &mut Vec<Finding>) {
    let Some(scripts) = pkg.get("scripts").and_then(|s| s.as_object()) else {
        return;
    };
    let text = std::fs::read_to_string(root.join("package.json")).unwrap_or_default();
    for (name, cmd) in scripts {
        let Some(cmd) = cmd.as_str() else { continue };
        let words: Vec<&str> = cmd.split_whitespace().collect();
        let Some(at) = words
            .windows(2)
            .position(|w| w[0].ends_with("nowaki") && matches!(w[1], "dev" | "start"))
        else {
            continue;
        };
        for w in words[at..].windows(2) {
            let (flag, value) = (w[0], w[1]);
            if flag != "--host"
                || value.starts_with('-')
                || value.parse::<std::net::IpAddr>().is_ok()
            {
                continue;
            }
            let looks_like_dir =
                value.contains('/') || value == "." || value == ".." || root.join(value).is_dir();
            if !looks_like_dir || matches!(value, "&&" | "||" | ";" | "|") {
                continue;
            }
            let line = text
                .find(&format!("\"{name}\""))
                .map(|o| line_of(&text, o))
                .unwrap_or(1);
            out.push(Finding::at(
                Level::Must,
                "package.json",
                line,
                format!("script `{name}`: `--host {value}` reads `{value}` as the listen address since 0.20.0 (`--host` takes an optional address)"),
                format!("Put the directory before the flag (`nowaki {} {value} --host`) or give an address (`--host 0.0.0.0`).", words[at + 1]),
            ));
        }
    }
}

/// `PORT=` in `.env` files: `nowaki dev` / `nowaki start` read `PORT` since 0.20.0, which matters
/// when something loads `.env` into the environment (Docker `env_file`, dotenv-cli, …).
fn scan_env_files(root: &Path, out: &mut Vec<Finding>) {
    for name in [".env", ".env.local", ".env.development", ".env.production"] {
        let Ok(text) = std::fs::read_to_string(root.join(name)) else {
            continue;
        };
        for (i, line) in text.lines().enumerate() {
            let t = line.trim_start().trim_start_matches("export ").trim_start();
            if let Some(v) = t.strip_prefix("PORT=") {
                out.push(Finding::at(
                    Level::Check,
                    name,
                    i + 1,
                    format!("PORT={} is set here: since 0.20.0 `nowaki dev` and `nowaki start` listen on PORT when there is no --port", v.trim()),
                    "If your environment loads this file and PORT is meant for something else, pass --port to nowaki dev / start.".into(),
                ));
            }
        }
    }
}

fn scan_facts(pkg: &serde_json::Value, facts: &Facts, out: &mut Vec<Finding>) {
    let env = |level, what: String, fix: String| Finding {
        level,
        file: None,
        line: None,
        what,
        fix,
    };
    if let Some(port) = &facts.port_env {
        out.push(env(
            Level::Check,
            format!("PORT={port} is set in this shell: since 0.20.0 `nowaki dev` and `nowaki start` listen on it when there is no --port"),
            "Pass --port if PORT is meant for something else.".into(),
        ));
    }
    if let (Some(cli), Some(rt)) = (&facts.cli_installed, &facts.runtime_installed) {
        if cli != rt {
            out.push(env(
                Level::Must,
                format!("nowaki {cli} and @nowaki-dev/runtime {rt} are installed; the CLI refuses a runtime of another version line"),
                "Install the same version of both (`nowaki upgrade` does).".into(),
            ));
        }
    }
    match facts.node.as_deref().and_then(Version::parse) {
        Some(v) if v.major < MIN_NODE => out.push(env(
            Level::Must,
            format!("Node {v} is older than the supported Node {MIN_NODE}"),
            format!("Install Node {MIN_NODE} or newer (an LTS line)."),
        )),
        Some(_) => {}
        None => out.push(env(
            Level::Check,
            "`node --version` did not run".into(),
            format!("Nowaki needs Node {MIN_NODE} or newer on PATH."),
        )),
    }
    if let Some(engines) = pkg.pointer("/engines/node").and_then(|v| v.as_str()) {
        let allows_older = range_version(engines).is_some_and(|v| v.major < MIN_NODE);
        if allows_older {
            out.push(Finding::at(
                Level::Check,
                "package.json",
                1,
                format!("`engines.node` is \"{engines}\", which allows Node lines Nowaki doesn't support"),
                format!("Use \">={MIN_NODE}\"."),
            ));
        }
    }
    let msrv = env!("CARGO_PKG_RUST_VERSION");
    if let (Some(have), Some(want)) = (
        facts.rustc.as_deref().and_then(Version::parse),
        Version::parse(&format!("{msrv}.0")).or_else(|| Version::parse(msrv)),
    ) {
        if have < want {
            out.push(env(
                Level::Check,
                format!("rustc {have} is older than {msrv}, the oldest Rust that builds the nowaki crate"),
                "Only matters for `cargo install nowaki`; the npm package ships prebuilt binaries. Run `rustup update`.".into(),
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for (rel, text) in files {
            let p = dir.path().join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        }
        dir
    }

    fn facts() -> Facts {
        Facts {
            node: Some("22.11.0".into()),
            rustc: Some("1.97.0".into()),
            current: Version::parse("0.19.0"),
            ..Default::default()
        }
    }

    fn run(dir: &tempfile::TempDir, facts: &Facts) -> Vec<Finding> {
        let pkg = std::fs::read_to_string(dir.path().join("package.json"))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or(serde_json::json!({}));
        scan(dir.path(), &pkg, facts)
    }

    fn locs(found: &[Finding], level: Level) -> Vec<String> {
        found
            .iter()
            .filter(|f| f.level == level)
            .map(Finding::location)
            .collect()
    }

    #[test]
    fn removed_aliases_are_must_change_with_file_and_line() {
        let dir = app(&[
            ("routes/_error.tsx", "export default () => <p>oops</p>;\n"),
            ("routes/(admin)/_error.jsx", "export default () => null;\n"),
            ("routes/error.tsx", "export default () => null;\n"),
            // A page's document head, not a HEAD handler.
            ("routes/about.tsx", "export const head = \"<meta name=x>\";\nexport default () => null;\n"),
            (
                "routes/_middleware.ts",
                "import x from \"./x.ts\";\n\nexport const middleware = async (ctx) => {};\n",
            ),
            (
                "routes/api/hello.ts",
                "export function get() { return {}; }\nexport async function post(ctx) {}\nexport const csrf = false;\n",
            ),
            ("routes/api/ok.ts", "export function GET() { return {}; }\n"),
            ("node_modules/x/routes/_error.tsx", ""),
            ("nowaki.config.mjs", "export const config = { site: \"https://a.example\" };\n"),
        ]);
        let found = run(&dir, &facts());
        assert_eq!(
            locs(&found, Level::Must),
            [
                "nowaki.config.mjs:1",
                "routes/(admin)/_error.jsx:1",
                "routes/_error.tsx:1",
                "routes/_middleware.ts:3",
                "routes/api/hello.ts:1",
                "routes/api/hello.ts:2",
            ],
            "{found:#?}"
        );
        let rename = &found
            .iter()
            .find(|f| f.location() == "routes/(admin)/_error.jsx:1")
            .unwrap()
            .fix;
        assert!(rename.contains("routes/(admin)/_500.jsx"), "{rename}");
        let get = found
            .iter()
            .find(|f| f.location() == "routes/api/hello.ts:1")
            .unwrap();
        assert!(get.fix.contains("`GET`"), "{get:?}");
        // csrf is exported: no CSRF hint for this route.
        assert!(locs(&found, Level::Check)
            .iter()
            .all(|l| !l.starts_with("routes/api/hello.ts")));
    }

    #[test]
    fn unknown_config_keys_are_found_in_every_export_shape() {
        let shapes = [
            "export default {\n  site: \"https://a.example\",\n  basepath: \"/x\",\n};\n",
            "import { defineConfig } from \"@nowaki-dev/runtime/config\";\nexport default defineConfig({\n  site: \"https://a.example\",\n  basepath: \"/x\",\n});\n",
            "const config = {\n  site: \"https://a.example\",\n  basepath: \"/x\",\n};\nexport default config;\n",
        ];
        for text in shapes {
            let mut out = Vec::new();
            scan_config("nowaki.config.mjs", text, &mut out);
            let unknown: Vec<_> = out.iter().map(|f| (f.location(), f.fix.clone())).collect();
            assert_eq!(unknown.len(), 1, "{text}\n{unknown:?}");
            assert!(
                unknown[0].0.ends_with(":3") || unknown[0].0.ends_with(":4"),
                "{unknown:?}"
            );
            assert!(
                unknown[0].1.contains("Did you mean `basePath`?"),
                "{unknown:?}"
            );
        }
        // Nested keys, methods, quoted keys, comments and strings with braces.
        let text = r#"// export default { nope: 1 }
export default {
  /* cors: { } */
  "i18n": { locales: ["en", "ja"], defaultLocale: "en" },
  redirects: async () => [{ source: "/a{b}", destination: "/c" }],
  plugins: [markdoc()],
  async headers() { return []; },
  images: { remotePatterns: [] },
  fonts,
  experimental: { x: 1 },
};
"#;
        let keys: Vec<_> = config_keys(text)
            .unwrap()
            .into_iter()
            .map(|(k, _)| k)
            .collect();
        assert_eq!(
            keys,
            [
                "i18n",
                "redirects",
                "plugins",
                "headers",
                "images",
                "fonts",
                "experimental"
            ]
        );
        let mut out = Vec::new();
        scan_config("nowaki.config.mjs", text, &mut out);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].location(), "nowaki.config.mjs:10");
        // Built another way: nothing to say.
        assert!(config_keys("export default makeConfig();\n").is_none());
    }

    #[test]
    fn form_data_used_as_url_search_params_is_flagged() {
        let dir = app(&[(
            "routes/search.tsx",
            r#"export async function action(ctx) {
  const form = await ctx.formData();
  const q = form.get("q").trim();
  const ok = String(form.get("q") ?? "");
  const qs = form.toString();
  const n = form.size;
  const platform = form.get("x");
  return `${form}`;
}
"#,
        )]);
        let found = run(&dir, &facts());
        assert_eq!(
            locs(&found, Level::Check)
                .into_iter()
                .filter(|l| l.starts_with("routes/"))
                .collect::<Vec<_>>(),
            [
                "routes/search.tsx:3",
                "routes/search.tsx:5",
                "routes/search.tsx:6",
                "routes/search.tsx:8",
            ],
            "{found:#?}"
        );
    }

    #[test]
    fn csrf_hint_only_for_apps_from_before_0_19_3() {
        let files = [("routes/api/hook.ts", "export async function POST(ctx) {}\n")];
        let dir = app(&files);
        let old = run(&dir, &facts());
        assert!(locs(&old, Level::Check).contains(&"routes/api/hook.ts:1".to_string()));
        let mut newer = facts();
        newer.current = Version::parse("0.19.3");
        assert!(
            !locs(&run(&dir, &newer), Level::Check).contains(&"routes/api/hook.ts:1".to_string())
        );
        // A page with a POST export is not an API route.
        let dir = app(&[("routes/about.tsx", "export async function POST() {}\n")]);
        assert!(locs(&run(&dir, &facts()), Level::Check).is_empty());
    }

    #[test]
    fn scripts_env_and_versions() {
        let dir = app(&[
            (
                "package.json",
                r#"{
  "scripts": {
    "dev": "nowaki dev --host app",
    "lan": "nowaki dev --host --open",
    "ip": "nowaki start --host 10.0.0.5",
    "build": "nowaki build"
  },
  "engines": { "node": ">=18" }
}
"#,
            ),
            ("app/routes/index.tsx", "export default () => null;\n"),
            (".env", "SITE=x\nPORT=8080\n"),
        ]);
        let mut f = facts();
        f.node = Some("20.10.0".into());
        f.rustc = Some("1.80.0".into());
        f.port_env = Some("4000".into());
        f.cli_installed = Some("0.19.3".into());
        f.runtime_installed = Some("0.19.2".into());
        let found = run(&dir, &f);
        let must: Vec<_> = found.iter().filter(|x| x.level == Level::Must).collect();
        assert_eq!(must[0].location(), "package.json:3", "{found:#?}");
        assert!(
            must[0].fix.contains("nowaki dev app --host"),
            "{:?}",
            must[0]
        );
        assert!(
            must.iter().any(|x| x.what.contains("Node 20.10.0")),
            "{must:#?}"
        );
        assert!(must.iter().any(|x| x
            .what
            .contains("nowaki 0.19.3 and @nowaki-dev/runtime 0.19.2")));
        assert_eq!(must.len(), 3, "{must:#?}");
        let check: Vec<_> = found.iter().filter(|x| x.level == Level::Check).collect();
        assert!(check.iter().any(|x| x.location() == ".env:2"), "{check:#?}");
        assert!(check.iter().any(|x| x.what.contains("PORT=4000")));
        assert!(check.iter().any(|x| x.what.contains("engines.node")));
        assert!(check.iter().any(|x| x.what.contains("rustc 1.80.0")));
    }

    #[test]
    fn a_clean_app_has_no_findings() {
        let dir = app(&[
            ("package.json", r#"{"scripts":{"dev":"nowaki dev --host"},"engines":{"node":">=22"}}"#),
            ("routes/_500.tsx", "export default () => null;\n"),
            ("routes/_middleware.ts", "export default async function middleware() {}\n"),
            ("routes/api/x.ts", "export function GET() {}\nexport const csrf = false;\nexport function POST() {}\n"),
            (
                "routes/form.tsx",
                "export async function action(ctx) {\n  const form = await ctx.formData();\n  return String(form.get(\"q\") ?? \"\");\n}\n",
            ),
            ("nowaki.config.mjs", "export default { site: \"https://a.example\", basePath: \"/x\" };\n"),
        ]);
        let found = run(&dir, &facts());
        assert!(found.is_empty(), "{found:#?}");
    }

    #[test]
    fn versions_from_ranges_and_commands() {
        assert_eq!(range_version("^0.19.3"), Version::parse("0.19.3"));
        assert_eq!(range_version(">= 0.18.0"), Version::parse("0.18.0"));
        assert_eq!(range_version("latest"), None);
        assert_eq!(range_version(">=18"), Version::parse("18.0.0"));
        assert_eq!(range_version("^22.1"), Version::parse("22.1.0"));
        assert_eq!(first_version("v22.11.0\n").as_deref(), Some("22.11.0"));
        assert_eq!(
            first_version("rustc 1.97.0 (abc 2026-10-01)").as_deref(),
            Some("1.97.0")
        );
        assert_eq!(
            exported_name("export async function POST(ctx) {"),
            Some("POST")
        );
        assert_eq!(exported_name("export const csrf = false;"), Some("csrf"));
        assert_eq!(exported_name("export default function Page() {}"), None);
        assert_eq!(exported_name("exported = 1"), None);
    }
}
