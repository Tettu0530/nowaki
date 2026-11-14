//! Import edges between app modules: the server build's module graph, the remote image prefetch,
//! and dev tooling (`nowaki dev`'s MCP endpoint).
//!
//! The dev server transforms modules one request at a time and keeps no graph, so edges come
//! from parsing each source (through `read_source`) and resolving its specifiers the way the
//! transforms do.

use std::path::{Path, PathBuf};

use anyhow::Result;
use oxc::allocator::Allocator;
use oxc::ast::ast::{Expression, ImportExpression, Statement};
use oxc::ast_visit::{walk, Visit};

use crate::NowakiCore;

/// One import of a module.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModuleImport {
    /// The specifier as written.
    pub specifier: String,
    /// Absolute path it resolves to; None when it doesn't resolve (or is a URL).
    pub resolved: Option<PathBuf>,
    /// `import("…")` rather than a static import / re-export.
    pub dynamic: bool,
}

/// Static imports, re-exports (`export … from`), and string-literal `import()` of a module.
/// Type-only imports are skipped; they don't exist at runtime.
pub fn module_imports(core: &NowakiCore, abs: &Path) -> Result<Vec<ModuleImport>> {
    let source = core.read_source(abs)?;
    let specs = import_specifiers(abs, &source)?;
    let dir = abs.parent().unwrap_or(&core.root);
    Ok(specs
        .into_iter()
        .map(|(specifier, dynamic)| ModuleImport {
            resolved: resolve(core, dir, &specifier),
            specifier,
            dynamic,
        })
        .collect())
}

/// App sources under the root (skips `node_modules`, build output, and dot directories).
pub fn app_sources(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    walk_sources(root, &mut out);
    out.sort();
    out
}

/// App modules that import `target` (statically or with `import()`).
pub fn importers(core: &NowakiCore, target: &Path) -> Vec<PathBuf> {
    app_sources(&core.root)
        .into_iter()
        .filter(|abs| abs != target)
        .filter(|abs| {
            module_imports(core, abs)
                .map(|imports| {
                    imports
                        .iter()
                        .any(|i| i.resolved.as_deref() == Some(target))
                })
                .unwrap_or(false)
        })
        .collect()
}

/// The import specifiers of `source` as `(specifier, dynamic)`, in [`module_imports`]' order:
/// static imports and re-exports first, then string-literal `import()`.
pub(crate) fn import_specifiers(abs: &Path, source: &str) -> Result<Vec<(String, bool)>> {
    let allocator = Allocator::default();
    let source_type = crate::transform::source_type_for_path(abs);
    let program = crate::transform::parse_program(&allocator, abs, source, source_type)?;
    let mut out = Vec::new();
    for stmt in &program.body {
        match stmt {
            Statement::ImportDeclaration(d) if !d.import_kind.is_type() => {
                if let Some(spec) = d.source.value.as_str() {
                    out.push((spec.to_string(), false));
                }
            }
            Statement::ExportFromDeclaration(d) if !d.export_kind.is_type() => {
                if let Some(spec) = d.source.value.as_str() {
                    out.push((spec.to_string(), false));
                }
            }
            Statement::ExportAllDeclaration(d) if !d.export_kind.is_type() => {
                if let Some(spec) = d.source.value.as_str() {
                    out.push((spec.to_string(), false));
                }
            }
            _ => {}
        }
    }
    let mut dynamic = DynamicImports(Vec::new());
    dynamic.visit_program(&program);
    out.extend(dynamic.0.into_iter().map(|s| (s, true)));
    Ok(out)
}

struct DynamicImports(Vec<String>);

impl<'a> Visit<'a> for DynamicImports {
    fn visit_import_expression(&mut self, it: &ImportExpression<'a>) {
        if let Expression::StringLiteral(s) = &it.source {
            if let Some(spec) = s.value.as_str() {
                self.0.push(spec.to_string());
            }
        }
        walk::walk_import_expression(self, it);
    }
}

/// Resolves a specifier like the transforms (React aliases, plugins); None for absolute paths,
/// URLs, and `data:`.
fn resolve(core: &NowakiCore, dir: &Path, spec: &str) -> Option<PathBuf> {
    if spec.starts_with('/') || spec.contains("://") || spec.starts_with("data:") {
        return None;
    }
    let spec = crate::resolve::alias_specifier(spec).unwrap_or(spec);
    core.resolve_spec(dir, spec)
}

fn walk_sources(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if path.is_dir() {
            if name.starts_with('.')
                || matches!(
                    name.as_ref(),
                    "node_modules" | "dist" | "target" | crate::VIRTUAL_DIR
                )
            {
                continue;
            }
            walk_sources(&path, out);
        } else if crate::is_transformable(&path) {
            out.push(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collects_static_reexport_and_dynamic_imports() {
        let src = r#"
            import a from "./a.tsx";
            import type { T } from "./types.ts";
            import "./side.css";
            export { b } from "./b.ts";
            export * from "./c.ts";
            export type { U } from "./u.ts";
            const lazy = () => import("./lazy.tsx");
            const computed = (n) => import(n);
            import "./\uD800.ts";
            const lone = () => import("./\uDC00.ts");
        "#;
        let specs = import_specifiers(Path::new("x.tsx"), src).unwrap();
        // Specifiers with a lone surrogate name no file, so they're left out.
        assert_eq!(
            specs,
            vec![
                ("./a.tsx".to_string(), false),
                ("./side.css".to_string(), false),
                ("./b.ts".to_string(), false),
                ("./c.ts".to_string(), false),
                ("./lazy.tsx".to_string(), true),
            ]
        );
    }

    #[test]
    fn importers_and_imports_resolve_within_the_app() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        std::fs::create_dir_all(root.join("routes")).unwrap();
        std::fs::create_dir_all(root.join("islands")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        std::fs::write(
            root.join("routes/index.tsx"),
            "import C from \"../islands/C.tsx\";\nimport x from \"missing-pkg\";\nexport default () => <C />;\n",
        )
        .unwrap();
        std::fs::write(
            root.join("islands/C.tsx"),
            "export default () => <b>c</b>;\n",
        )
        .unwrap();
        std::fs::write(
            root.join("node_modules/pkg/i.js"),
            "import C from \"../../islands/C.tsx\";\n",
        )
        .unwrap();
        let root = dunce::canonicalize(&root).unwrap();
        let core = NowakiCore::new(root.clone());

        let imports = module_imports(&core, &root.join("routes/index.tsx")).unwrap();
        assert_eq!(imports[0].resolved, Some(root.join("islands/C.tsx")));
        assert_eq!(imports[1].resolved, None);

        let by = importers(&core, &root.join("islands/C.tsx"));
        assert_eq!(by, vec![root.join("routes/index.tsx")]);
    }
}
