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
    // Not canonicalized: NowakiCore::new does that (on macOS the temp dir is a symlink).
    let root = temp_app("deterministic", HOISTED_APP);
    let core = NowakiCore::new(root.clone());
    let mut builds = Vec::new();
    for i in 0..8 {
        let out = root.join(format!("dist{i}"));
        build_client(&core, &out).expect("build ok");
        builds.push(snapshot(&out.join("client")));
    }
    let _ = fs::remove_dir_all(&root);

    // The hoisted modules' order must not follow HashSet iteration, or the island chunk's
    // names, bytes and hash (and the manifest) change between identical builds.
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
    let root = temp_app("one-import", HOISTED_APP);
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

/// #92: a root given through a symlink still hoists the island's app modules.
#[cfg(unix)]
#[test]
fn a_symlinked_root_still_hoists() {
    let real = temp_app("symlinked", HOISTED_APP);
    let link = real.with_file_name(format!(
        "{}-link",
        real.file_name().unwrap().to_string_lossy()
    ));
    let _ = fs::remove_file(&link);
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let core = NowakiCore::new(link.clone());
    build_client(&core, &link.join("dist")).expect("build ok");
    let code = island_chunk(&link, "Many");
    let _ = fs::remove_file(&link);
    let _ = fs::remove_dir_all(&real);
    assert!(
        !code.contains("./cycle-"),
        "cycle modules were not hoisted through a symlinked root:\n{code}"
    );
}

/// Names the chunk reads but never declares or imports. These fixtures use no globals, so
/// anything listed would throw a ReferenceError at hydration.
fn unresolved_names(code: &str) -> Vec<String> {
    use oxc::allocator::Allocator;
    use oxc::parser::Parser;
    use oxc::semantic::SemanticBuilder;
    use oxc::span::SourceType;
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, code, SourceType::mjs()).parse();
    assert!(
        parsed.diagnostics.is_empty(),
        "chunk does not parse:\n{code}"
    );
    let semantic = SemanticBuilder::new().build(&parsed.program).semantic;
    let mut names: Vec<String> = semantic
        .scoping()
        .root_unresolved_references()
        .keys()
        .map(|k| k.to_string())
        .collect();
    names.sort();
    names
}

/// A binding re-exported with `export { x }` / `export { x as y }` (a barrel file), or exported
/// through a destructuring declaration, must stay defined in the hoisted island chunk.
#[test]
fn hoisted_island_keeps_reexported_and_destructured_bindings() {
    let root = temp_app(
        "reexport",
        &[
            (
                "lib/barrel/x.ts",
                "export function greet() { return \"hi-from-x\"; }\nexport const two = 2;\n",
            ),
            (
                "lib/barrel/index.ts",
                "import { greet, two } from \"./x.ts\";\nexport { greet, two as deux };\n",
            ),
            (
                "lib/outer.ts",
                "import { greet } from \"./barrel/index.ts\";\nexport { greet as hello };\n",
            ),
            (
                "lib/destr.ts",
                "export const { alpha, beta: b2, ...rest } = { alpha: \"A1\", beta: \"B1\", c: 1 };\nexport const [first, , third] = [1, 2, 3];\n",
            ),
            (
                "islands/Barrel.ts",
                "import { greet, deux } from \"../lib/barrel/index.ts\";\nimport { hello } from \"../lib/outer.ts\";\nexport default function Barrel() { return greet() + deux + hello(); }\n",
            ),
            (
                "islands/Destr.ts",
                "import { alpha, b2, rest, first, third } from \"../lib/destr.ts\";\nexport default function Destr() { return alpha + b2 + rest.c + first + third; }\n",
            ),
        ],
    );
    let core = NowakiCore::new(root.clone());
    build_client(&core, &root.join("dist")).expect("build ok");
    let barrel = island_chunk(&root, "Barrel");
    let destr = island_chunk(&root, "Destr");
    let _ = fs::remove_dir_all(&root);

    assert_eq!(
        unresolved_names(&barrel),
        Vec::<String>::new(),
        "barrel island reads undefined names:\n{barrel}"
    );
    assert!(barrel.contains("hi-from-x"), "greet was dropped:\n{barrel}");
    // Hoisted, not the unbundled fallback: the lib modules live inside the chunk.
    assert!(
        !barrel.contains("import") && !destr.contains("import"),
        "lib modules were not hoisted:\n{barrel}\n{destr}"
    );
    assert_eq!(
        unresolved_names(&destr),
        Vec::<String>::new(),
        "destructuring island reads undefined names:\n{destr}"
    );
    assert!(destr.contains("A1"), "alpha was dropped:\n{destr}");
}

/// `nowaki start` (start.rs `asset_name`) serves only `[A-Za-z0-9._-]` names that don't start
/// with '.', so every file the build writes to dist/client must have such a name, whatever the
/// source file is called.
#[test]
fn build_output_names_are_servable_for_any_source_name() {
    let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1\" height=\"1\"></svg>\n";
    let root = temp_app(
        "names",
        &[
            ("assets/logo@2x.svg", svg),
            ("assets/my logo.svg", svg),
            ("assets/.dot.svg", svg),
            ("assets/\u{30ed}\u{30b4}.svg", svg),
            ("assets/server+only.svg", svg),
            ("lib/my util.ts", "export const u = \"u\";\n"),
            ("islands/card+x.module.css", ".card { color: red }\n"),
            ("styles/page@wide.css", "body { margin: 0 }\n"),
            (
                "islands/Card.ts",
                "import a from \"../assets/logo@2x.svg\";\nimport b from \"../assets/my logo.svg\";\nimport c from \"../assets/.dot.svg\";\nimport d from \"../assets/\u{30ed}\u{30b4}.svg\";\nimport * as m from \"../lib/my util.ts\";\nimport s from \"./card+x.module.css\";\nexport default function Card() { return s.card + a + b + c + d + m.u; }\n",
            ),
            (
                "routes/index.tsx",
                "import \"../styles/page@wide.css\";\nimport e from \"../assets/server+only.svg\";\nimport Card from \"../islands/Card.ts\";\nexport default function I() { return <main><img src={e} /><Card /></main>; }\n",
            ),
        ],
    );
    NowakiCore::new(root.clone())
        .build(&root.join("dist"))
        .expect("build ok");
    let names: Vec<String> = fs::read_dir(root.join("dist/client"))
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    let _ = fs::remove_dir_all(&root);

    let bad: Vec<&String> = names
        .iter()
        .filter(|n| {
            n.starts_with('.')
                || !n
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        })
        .collect();
    assert!(bad.is_empty(), "unservable output names: {bad:?}");
    for stem in [
        "logo_2x.",
        "my_logo.",
        "server_only.",
        "card_x.module.css.",
        "page_wide.",
    ] {
        assert!(
            names.iter().any(|n| n.starts_with(stem)),
            "no {stem}* in {names:?}"
        );
    }
}

#[test]
fn manifest_stays_json_for_odd_island_names() {
    let island = "export default function X() { return null; }\n";
    let root = temp_app(
        "manifest-json",
        &[
            ("islands/It's \u{fc}.ts", island),
            ("islands/Plain.ts", island),
        ],
    );
    build_client(&NowakiCore::new(root.clone()), &root.join("dist")).expect("build ok");
    let text = fs::read_to_string(root.join("dist/client/manifest.json")).unwrap();
    let manifest: serde_json::Value = serde_json::from_str(&text).expect("valid JSON");
    assert!(manifest["islands"]["It's \u{fc}"].is_string(), "{text}");
    assert!(manifest["islands"]["Plain"].is_string(), "{text}");

    // A quote can't round-trip through the page's `<nowaki-island name>`: a clear error, not a
    // broken manifest. Windows doesn't allow `"` in a file name, so there is nothing to check.
    if cfg!(windows) {
        let _ = fs::remove_dir_all(&root);
        return;
    }
    fs::write(root.join("islands/Say\"Hi\".ts"), island).unwrap();
    let Err(err) = build_client(&NowakiCore::new(root.clone()), &root.join("dist")) else {
        panic!("a quote in an island name should fail the build");
    };
    let err = err.to_string();
    let _ = fs::remove_dir_all(&root);
    assert!(err.contains("Say\"Hi\".ts"), "{err}");
    assert!(err.contains("which an island name can't"), "{err}");
}
