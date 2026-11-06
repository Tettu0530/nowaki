//! Live island detection and "could be live" build hints, both from the AST.
//!
//! A live island (`export const live`) renders on the server and ships no component JS. Many
//! client islands only keep some state and react to clicks or form input; those would work the
//! same as live islands, with zero JS, at the cost of a server round trip per event. The build
//! points them out, and also points out islands with no state and no event handlers at all, which
//! don't need to be islands.

use std::collections::BTreeSet;
use std::path::Path;

use oxc::allocator::Allocator;
use oxc::ast::ast::{
    CallExpression, Declaration, ExportSpecifier, Expression, IdentifierReference, JSXAttribute,
    JSXAttributeName, Statement,
};
use oxc::ast_visit::{walk, Visit};

/// Whether the module exports a binding named `live` (`export const live = …`,
/// `export function live`, `export { x as live }`, `export { live } from "…"`). Comments and
/// strings don't count.
pub fn exports_live(path: &Path, source: &str) -> bool {
    if !source.contains("live") {
        return false;
    }
    let allocator = Allocator::default();
    let source_type = crate::transform::source_type_for_path(path);
    let Ok(program) = crate::transform::parse_program(&allocator, path, source, source_type) else {
        return false;
    };
    let names_live = |specifiers: &[ExportSpecifier<'_>]| {
        specifiers
            .iter()
            .any(|s| !s.export_kind.is_type() && s.exported.name() == "live")
    };
    program.body.iter().any(|stmt| match stmt {
        Statement::ExportDeclaration(d) if !d.export_kind().is_type() => match &d.declaration {
            Declaration::VariableDeclaration(v) => v.declarations.iter().any(|decl| {
                decl.id
                    .get_binding_identifier()
                    .is_some_and(|id| id.name == "live")
            }),
            Declaration::FunctionDeclaration(f) => {
                f.id.as_ref().is_some_and(|id| id.name == "live")
            }
            Declaration::ClassDeclaration(c) => c.id.as_ref().is_some_and(|id| id.name == "live"),
            _ => false,
        },
        Statement::ExportNamedDeclaration(d) if !d.export_kind.is_type() => {
            names_live(&d.specifiers)
        }
        Statement::ExportFromDeclaration(d) if !d.export_kind.is_type() => {
            names_live(&d.specifiers)
        }
        _ => false,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HintKind {
    /// State and click / form events only: works as a live island with no client JS.
    CouldBeLive,
    /// No state and no event handlers: renders the same as a plain server component.
    NoInteractivity,
}

#[derive(Debug, Clone)]
pub struct Hint {
    pub kind: HintKind,
    /// What the island uses, for the message (e.g. "useState, onClick").
    pub uses: Vec<String>,
}

/// Hooks whose result a live island reproduces (state kept on the server between events).
const STATE_HOOKS: [&str; 2] = ["useState", "useReducer"];
/// Pure hooks that work the same in a server render.
const PURE_HOOKS: [&str; 3] = ["useMemo", "useCallback", "useId"];
/// Events Jetstream sends to the server (`data-live`, `data-live-submit`, `data-live-input`,
/// `data-live-change`).
const LIVE_EVENTS: [&str; 4] = ["onClick", "onSubmit", "onInput", "onChange"];
/// Browser-only globals: an island that touches them needs to run in the browser.
const BROWSER_GLOBALS: [&str; 22] = [
    "window",
    "document",
    "navigator",
    "location",
    "history",
    "localStorage",
    "sessionStorage",
    "indexedDB",
    "fetch",
    "setTimeout",
    "setInterval",
    "requestAnimationFrame",
    "requestIdleCallback",
    "matchMedia",
    "IntersectionObserver",
    "ResizeObserver",
    "MutationObserver",
    "WebSocket",
    "EventSource",
    "Notification",
    "alert",
    "confirm",
];

/// Looks at one client island's own source. None when it needs the browser (other hooks, other
/// events, browser globals, or imports other than preact / React / CSS), or can't be parsed.
/// Imported app modules aren't followed, so an island that imports one gets no hint.
pub fn hint_for_island(path: &Path, source: &str) -> Option<Hint> {
    let allocator = Allocator::default();
    let source_type = crate::transform::source_type_for_path(path);
    let program = crate::transform::parse_program(&allocator, path, source, source_type).ok()?;
    for stmt in &program.body {
        if let Statement::ImportDeclaration(d) = stmt {
            if d.import_kind.is_type() {
                continue;
            }
            let src = d.source.value.as_str();
            let ok = matches!(
                src,
                "preact" | "preact/hooks" | "preact/compat" | "react" | "react/jsx-runtime"
            ) || src.ends_with(".css");
            if !ok {
                return None;
            }
        }
    }
    let mut seen = Seen::default();
    seen.visit_program(&program);
    if seen.blocked {
        return None;
    }
    let mut uses: Vec<String> = seen
        .hooks
        .iter()
        .chain(seen.events.iter())
        .cloned()
        .collect();
    uses.dedup();
    let has_state = seen.hooks.iter().any(|h| STATE_HOOKS.contains(&h.as_str()));
    if seen.events.is_empty() && !has_state {
        return Some(Hint {
            kind: HintKind::NoInteractivity,
            uses,
        });
    }
    if has_state && !seen.events.is_empty() {
        return Some(Hint {
            kind: HintKind::CouldBeLive,
            uses,
        });
    }
    // Events without state (or state never changed by an event) have nothing to send.
    None
}

#[derive(Default)]
struct Seen {
    hooks: BTreeSet<String>,
    events: BTreeSet<String>,
    blocked: bool,
}

impl<'a> Visit<'a> for Seen {
    fn visit_call_expression(&mut self, it: &CallExpression<'a>) {
        if let Expression::Identifier(id) = &it.callee {
            let name = id.name.as_str();
            if name.starts_with("use") && name.len() > 3 {
                if STATE_HOOKS.contains(&name) || PURE_HOOKS.contains(&name) {
                    self.hooks.insert(name.to_string());
                } else {
                    // useEffect, useRef, useContext, custom hooks…: need the browser.
                    self.blocked = true;
                }
            }
        }
        walk::walk_call_expression(self, it);
    }

    fn visit_identifier_reference(&mut self, it: &IdentifierReference<'a>) {
        if BROWSER_GLOBALS.contains(&it.name.as_str()) {
            self.blocked = true;
        }
    }

    fn visit_jsx_attribute(&mut self, it: &JSXAttribute<'a>) {
        if let JSXAttributeName::Identifier(id) = &it.name {
            let name = id.name.as_str();
            let is_event =
                name.len() > 2 && name.starts_with("on") && name.as_bytes()[2].is_ascii_uppercase();
            if is_event {
                if LIVE_EVENTS.contains(&name) {
                    self.events.insert(name.to_string());
                } else {
                    self.blocked = true; // onKeyDown, onMouseMove, onScroll…
                }
            }
            if name == "ref" {
                self.blocked = true;
            }
        }
        walk::walk_jsx_attribute(self, it);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn live(src: &str) -> bool {
        exports_live(Path::new("islands/X.tsx"), src)
    }

    fn hint(src: &str) -> Option<HintKind> {
        hint_for_island(Path::new("islands/X.tsx"), src).map(|h| h.kind)
    }

    #[test]
    fn detects_every_form_of_a_live_export() {
        assert!(live("export const live = { on: {} };"));
        assert!(live("export function live() {}"));
        assert!(live("const cfg = {}; export { cfg as live };"));
        assert!(live("export { live } from \"./shared.ts\";"));
        assert!(live("export const a = 1, live = {};"));
    }

    #[test]
    fn ignores_comments_strings_and_other_names() {
        assert!(!live(
            "// export const live = {}\nexport default () => null;"
        ));
        assert!(!live(
            "const s = \"export const live = 1\"; export default s;"
        ));
        assert!(!live("export const liveness = 1;"));
        assert!(!live("const live = 1; export default live;"));
        assert!(!live("export type { live } from \"./t.ts\";"));
    }

    const COUNTER: &str = r#"import { useState } from "preact/hooks";
export default function Counter() {
  const [n, set] = useState(0);
  return <button onClick={() => set(n + 1)}>{n}</button>;
}"#;

    #[test]
    fn a_state_and_click_island_could_be_live() {
        assert_eq!(hint(COUNTER), Some(HintKind::CouldBeLive));
        let h = hint_for_island(Path::new("islands/X.tsx"), COUNTER).unwrap();
        assert_eq!(h.uses, ["useState", "onClick"]);
    }

    #[test]
    fn an_island_without_state_or_events_needs_no_island() {
        assert_eq!(
            hint("import s from \"./B.module.css\";\nexport default () => <span class={s.b}>v1</span>;"),
            Some(HintKind::NoInteractivity)
        );
    }

    #[test]
    fn browser_only_islands_get_no_hint() {
        for src in [
            "import { useEffect, useState } from \"preact/hooks\";\nexport default () => { const [a] = useState(0); useEffect(() => {}); return <b onClick={() => {}}>{a}</b>; };",
            "import { useState } from \"preact/hooks\";\nexport default () => { const [a, s] = useState(0); return <input onKeyDown={() => s(1)} value={a} />; };",
            "import { useState } from \"preact/hooks\";\nexport default () => { const [a, s] = useState(0); return <b onClick={() => s(localStorage.length)}>{a}</b>; };",
            "import { useState } from \"preact/hooks\";\nimport confetti from \"canvas-confetti\";\nexport default () => { const [a, s] = useState(0); return <b onClick={() => { confetti(); s(1); }}>{a}</b>; };",
            "import { useState } from \"preact/hooks\";\nimport { helper } from \"../lib/h.ts\";\nexport default () => { const [a, s] = useState(0); return <b onClick={() => s(helper())}>{a}</b>; };",
            "import { useRef } from \"preact/hooks\";\nexport default () => { const r = useRef(); return <b ref={r} />; };",
        ] {
            assert_eq!(hint(src), None, "{src}");
        }
    }

    #[test]
    fn events_without_state_get_no_hint() {
        assert_eq!(
            hint("export default () => <b onClick={() => console.log(1)}>x</b>;"),
            None
        );
    }
}
