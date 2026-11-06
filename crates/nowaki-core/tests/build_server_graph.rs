//! The server build must emit every app module the server can load at runtime, including
//! ones reached only through a `"use server"` module, `export … from`, or `import("…")`.

use std::fs;

use nowaki_core::NowakiCore;

#[test]
fn server_build_follows_use_server_reexports_and_dynamic_imports() {
    let root = std::env::temp_dir().join(format!("nowaki-server-graph-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let files: &[(&str, &str)] = &[
        (
            "actions/save.ts",
            "\"use server\";\nimport { shout } from \"../utils/helper.ts\";\nexport async function save(s: string) { return shout(s); }\n",
        ),
        (
            "utils/helper.ts",
            "export function shout(s: string) { return s.toUpperCase() + \"!\"; }\n",
        ),
        (
            "lib/re.ts",
            "export * from \"../shared/a.ts\";\nexport { b1 as named } from \"../shared/named.ts\";\n",
        ),
        ("shared/a.ts", "export const a = \"from-reexport\";\n"),
        ("shared/named.ts", "export const b1 = \"named\";\n"),
        (
            "routes/re.tsx",
            "import { a } from \"../lib/re.ts\";\nexport default async function Re() {\n  const { b } = await import(\"../shared/b.ts\");\n  return <p>{a}|{b}</p>;\n}\n",
        ),
        ("shared/b.ts", "export const b = \"from-dynamic\";\n"),
    ];
    for (rel, src) in files {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, src).unwrap();
    }

    NowakiCore::new(root.clone())
        .build(&root.join("dist"))
        .expect("build ok");
    let server = root.join("dist/server");
    let route = fs::read_to_string(server.join("routes/re.js")).unwrap_or_default();
    let missing: Vec<&str> = [
        "utils/helper.js",
        "shared/a.js",
        "shared/named.js",
        "shared/b.js",
    ]
    .into_iter()
    .filter(|rel| !server.join(rel).is_file())
    .collect();
    let _ = fs::remove_dir_all(&root);

    assert!(missing.is_empty(), "missing from dist/server: {missing:?}");
    // The dynamic import must point at the emitted .js file, like static imports do.
    assert!(
        route.contains("\"../shared/b.js\"") && !route.contains("b.ts"),
        "dynamic import specifier not rewritten:\n{route}"
    );
}

/// `.mjs` modules are emitted as `.js`, so the import that names them must say `.js` too, and
/// JSON the server imports must be in dist/server next to the module that imports it.
#[test]
fn server_build_rewrites_mjs_imports_and_copies_json() {
    let root = std::env::temp_dir().join(format!("nowaki-server-mjs-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let files: &[(&str, &str)] = &[
        ("lib/util.mjs", "export const util = \"from-mjs\";\n"),
        ("data/site.json", "{ \"name\": \"site\" }\n"),
        (
            "routes/index.tsx",
            "import { util } from \"../lib/util.mjs\";\nimport site from \"../data/site.json\" with { type: \"json\" };\nexport default function I() {\n  return <p>{util}|{site.name}</p>;\n}\n",
        ),
    ];
    for (rel, src) in files {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, src).unwrap();
    }

    NowakiCore::new(root.clone())
        .build(&root.join("dist"))
        .expect("build ok");
    let server = root.join("dist/server");
    let route = fs::read_to_string(server.join("routes/index.js")).unwrap_or_default();
    let util_js = server.join("lib/util.js").is_file();
    let json = fs::read_to_string(server.join("data/site.json")).unwrap_or_default();
    let _ = fs::remove_dir_all(&root);

    assert!(util_js, "lib/util.mjs not emitted as lib/util.js");
    assert!(
        route.contains("\"../lib/util.js\"") && !route.contains("util.mjs"),
        ".mjs import not rewritten:\n{route}"
    );
    assert!(
        json.contains("\"site\""),
        "data/site.json not copied to dist/server"
    );
}
