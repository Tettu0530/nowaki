//! Integration tests for transform_file (cases that need no import resolution).
//! Covers TS type stripping, JSX→preact, and the react→preact/compat alias.

use std::path::Path;

use nowaki_core::resolve::make_resolver;
use nowaki_core::transform::transform_file;
use nowaki_core::Mode;

#[test]
fn strips_types_and_transforms_jsx() {
    let resolver = make_resolver();
    let code = "const x: number = 1;\nexport default function App() { return <div class=\"a\">{x}</div>; }";
    let out = transform_file(
        Path::new("/app"),
        Path::new("/app/App.tsx"),
        code,
        Mode::Ssr,
        &resolver,
        &[],
        None,
    )
    .expect("transform ok");
    assert!(
        !out.contains(": number"),
        "type annotation should be stripped:\n{out}"
    );
    assert!(
        out.contains("jsx-runtime"),
        "jsx-runtime import expected:\n{out}"
    );
    assert!(
        out.contains("_jsx") || out.contains("jsx("),
        "jsx call expected:\n{out}"
    );
}

#[test]
fn aliases_react_to_preact_compat() {
    let resolver = make_resolver();
    let code = "import { useState } from \"react\";\nexport const useS = useState;";
    let out = transform_file(
        Path::new("/app"),
        Path::new("/app/x.ts"),
        code,
        Mode::Ssr,
        &resolver,
        &[],
        None,
    )
    .expect("transform ok");
    assert!(
        out.contains("preact/compat"),
        "react should alias to preact/compat:\n{out}"
    );
    assert!(
        !out.contains("\"react\""),
        "bare react should be gone:\n{out}"
    );
}

#[test]
fn applies_client_defines() {
    let resolver = make_resolver();
    let code = "export const mode = import.meta.env.MODE;";
    let defines = [(
        "import.meta.env.MODE".to_string(),
        "\"production\"".to_string(),
    )];
    let out = transform_file(
        Path::new("/app"),
        Path::new("/app/x.ts"),
        code,
        Mode::Browser,
        &resolver,
        &defines,
        None,
    )
    .expect("transform ok");
    assert!(
        out.contains("\"production\""),
        "define should be inlined:\n{out}"
    );
}
