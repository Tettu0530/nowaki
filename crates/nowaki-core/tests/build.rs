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

/// Every file under `dir` (relative path → bytes), sorted.
fn snapshot(dir: &std::path::Path) -> Vec<(String, Vec<u8>)> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in fs::read_dir(&d).unwrap().filter_map(|e| e.ok()) {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else {
                let rel = p.strip_prefix(dir).unwrap().to_string_lossy().into_owned();
                out.push((rel, fs::read(&p).unwrap()));
            }
        }
    }
    out.sort();
    out
}

// An island that hoists several app modules, two of them in an import cycle, plus a
// shared module that stays a separate chunk (another island uses it too).
const HOISTED_APP: &[(&str, &str)] = &[
    (
        "lib/cycle-a.ts",
        "import { b } from \"./cycle-b.ts\";\nexport function a() { return \"a\" + b(); }\n",
    ),
    (
        "lib/cycle-b.ts",
        "import { a } from \"./cycle-a.ts\";\nexport function b() { return \"b\"; }\nexport function full() { return a(); }\n",
    ),
    ("lib/one.ts", "export const one = () => 1;\n"),
    ("lib/two.ts", "export const two = () => 2;\n"),
    ("lib/three.ts", "export const three = () => 3;\n"),
    (
        "lib/shared.ts",
        "export const left = () => \"l\";\nexport const right = () => \"r\";\n",
    ),
    (
        "islands/Many.ts",
        "import { full } from \"../lib/cycle-b.ts\";\nimport { one } from \"../lib/one.ts\";\nimport { two } from \"../lib/two.ts\";\nimport { three } from \"../lib/three.ts\";\nimport { left } from \"../lib/shared.ts\";\nimport { right } from \"../lib/shared.ts\";\nexport default function Many() { return full() + one() + two() + three() + left() + right(); }\n",
    ),
    (
        "islands/Other.ts",
        "import { left } from \"../lib/shared.ts\";\nexport default function Other() { return left(); }\n",
    ),
];

#[test]
fn build_output_is_the_same_every_time() {
    // Canonical root, as the CLI resolves it: on macOS the temp dir is a symlink, and modules
    // resolved outside the literal root are not hoisted. dunce, because std's canonicalize
    // gives a verbatim `\\?\C:\…` path on Windows that resolved modules never match.
    let root = dunce::canonicalize(temp_app("deterministic", HOISTED_APP)).unwrap();
    let core = NowakiCore::new(root.clone());
    let mut builds = Vec::new();
    for i in 0..8 {
        let out = root.join(format!("dist{i}"));
        build_client(&core, &out).expect("build ok");
        builds.push(snapshot(&out.join("client")));
    }
    let _ = fs::remove_dir_all(&root);

    // The hoisted modules' order used to follow HashSet iteration, so the island chunk's
    // names, bytes and hash (and the manifest) changed between identical builds.
    let names = |s: &Vec<(String, Vec<u8>)>| s.iter().map(|(n, _)| n.clone()).collect::<Vec<_>>();
    let first = &builds[0];
    assert!(!first.is_empty());
    for (i, b) in builds.iter().enumerate().skip(1) {
        assert_eq!(names(first), names(b), "build {i} wrote different files");
        for ((name, x), (_, y)) in first.iter().zip(b) {
            assert!(x == y, "build {i} changed {name}");
        }
    }
}

#[test]
fn island_chunk_imports_each_shared_file_once_with_mangled_names() {
    let root = dunce::canonicalize(temp_app("one-import", HOISTED_APP)).unwrap();
    let core = NowakiCore::new(root.clone());
    build_client(&core, &root.join("dist")).expect("build ok");
    let code = island_chunk(&root, "Many");
    let _ = fs::remove_dir_all(&root);

    let shared = code.matches("\"./shared.").count();
    assert_eq!(
        shared, 1,
        "expected one import of the shared chunk:\n{code}"
    );
    // The cycle stays inside the island's scope.
    assert!(
        !code.contains("./cycle-"),
        "cycle modules were not hoisted:\n{code}"
    );
    // Hoisted names carry a `$<n>` suffix before minifying; mangling must remove them.
    assert!(!code.contains('$'), "names were not mangled:\n{code}");
    assert!(
        !code.contains("__PURE__"),
        "annotation comments were printed:\n{code}"
    );
}
