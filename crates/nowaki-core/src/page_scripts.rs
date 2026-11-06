//! Page scripts: `export const scripts = ["./hero.ts"]` in a route or layout ships those modules
//! to the browser as `<script type="module">`, bundled like an island (npm imports included) but
//! with no component and no hydration, like Astro's `<script>`.
//!
//! The list is read from the AST at build time (nowaki-core runs no JS), so it must be an array
//! of string literals: relative paths or package specifiers, resolved from the file that lists
//! them. The module never runs on the server; only the strings are part of the route module.

use std::path::Path;

use anyhow::{bail, Result};
use oxc::allocator::Allocator;
use oxc::ast::ast::{ArrayExpressionElement, BindingPattern, Declaration, Expression, Statement};

/// The specifiers in `export const scripts = [...]`, in order. Empty when there is no such
/// export; an error when there is one we can't read, so a typo never drops a script silently.
pub fn parse_scripts(path: &Path, source: &str) -> Result<Vec<String>> {
    if !source.contains("scripts") {
        return Ok(Vec::new());
    }
    let allocator = Allocator::default();
    let source_type = crate::transform::source_type_for_path(path);
    let program = crate::transform::parse_program(&allocator, path, source, source_type)?;
    for stmt in &program.body {
        let Statement::ExportDeclaration(d) = stmt else {
            continue;
        };
        let Declaration::VariableDeclaration(var) = &d.declaration else {
            continue;
        };
        for decl in &var.declarations {
            let BindingPattern::BindingIdentifier(id) = &decl.id else {
                continue;
            };
            if id.name != "scripts" {
                continue;
            }
            let Some(init) = decl.init.as_ref().map(unwrap_ts) else {
                bail!("`export const scripts` needs a value: an array of module paths");
            };
            let Expression::ArrayExpression(arr) = init else {
                bail!("`export const scripts` must be an array literal of module paths, like [\"./hero.ts\"]");
            };
            let mut out = Vec::new();
            for el in &arr.elements {
                match el {
                    ArrayExpressionElement::StringLiteral(s) => out.push(s.value.to_string()),
                    ArrayExpressionElement::TemplateLiteral(t)
                        if t.expressions.is_empty() && t.quasis.len() == 1 =>
                    {
                        let q = &t.quasis[0];
                        out.push(q.value.cooked.as_ref().unwrap_or(&q.value.raw).to_string());
                    }
                    _ => bail!(
                        "`export const scripts` entries must be string literals (read at build time)"
                    ),
                }
            }
            return Ok(out);
        }
    }
    Ok(Vec::new())
}

/// Looks through `as const`, `satisfies T`, and parentheses.
fn unwrap_ts<'a, 'b>(mut e: &'b Expression<'a>) -> &'b Expression<'a> {
    loop {
        e = match e {
            Expression::TSAsExpression(x) => &x.expression,
            Expression::TSSatisfiesExpression(x) => &x.expression,
            Expression::ParenthesizedExpression(x) => &x.expression,
            _ => return e,
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_string_arrays() {
        let p = Path::new("routes/index.tsx");
        assert_eq!(
            parse_scripts(
                p,
                "export const scripts = [\"./hero.ts\", `gsap-init`] as const;"
            )
            .unwrap(),
            ["./hero.ts", "gsap-init"]
        );
        assert!(parse_scripts(p, "export const title = 'scripts';")
            .unwrap()
            .is_empty());
        assert!(parse_scripts(p, "const scripts = ['./x.ts'];")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn rejects_what_it_cannot_read() {
        let p = Path::new("routes/index.tsx");
        assert!(parse_scripts(p, "export const scripts = list;").is_err());
        assert!(parse_scripts(p, "const a = './a.ts'; export const scripts = [a];").is_err());
    }
}
