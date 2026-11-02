//! Integration tests for build_client on small throwaway apps.

use std::fs;
use std::path::PathBuf;

use nowaki_core::build::build_client;
use nowaki_core::NowakiCore;

fn temp_app(name: &str, files: &[(&str, &str)]) -> PathBuf {
    let root =
        std::env::temp_dir().join(format!("nowaki-build-test-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    for (rel, src) in files {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, src).unwrap();
    }
    root
}

fn island_chunk(root: &std::path::Path, stem: &str) -> String {
    let client = root.join("dist/client");
    let entry = fs::read_dir(&client)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .find(|n| n.starts_with(&format!("{stem}.")) && n.ends_with(".js"))
        .unwrap_or_else(|| panic!("no {stem}.*.js in {}", client.display()));
    fs::read_to_string(client.join(entry)).unwrap()
}

#[test]
fn island_with_namespace_import_keeps_the_import() {
    let root = temp_app(
        "ns-import",
        &[
            ("lib/greet.ts", "export function greet() { return \"hi\"; }\n"),
            (
                "islands/Ns.ts",
                "import * as g from \"../lib/greet.ts\";\nexport default function Ns() { return g.greet(); }\n",
            ),
        ],
    );
    let core = NowakiCore::new(root.clone());
    build_client(&core, &root.join("dist")).expect("build ok");
    let code = island_chunk(&root, "Ns");
    let _ = fs::remove_dir_all(&root);

    // Scope hoisting can't concatenate `import * as`, so the island must keep a real
    // namespace import of the dependency instead of silently dropping it.
    assert!(
        code.contains("import*as") || code.contains("import * as"),
        "namespace import was dropped from the island chunk:\n{code}"
    );
    assert!(code.contains("greet"), "call site missing:\n{code}");
}
