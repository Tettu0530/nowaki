//! CLI integration test. Runs `nowaki build examples/hello` with the built binary and
//! checks output invariants (manifest, scope hoisting, zero JS for live islands).
//! Skipped when examples/hello has no node_modules.

use std::path::PathBuf;
use std::process::Command;

fn example_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../examples/hello")
        .canonicalize()
        .expect("examples/hello path")
}

fn deps_installed(root: &std::path::Path) -> bool {
    root.join("node_modules/preact").exists()
        && root.join("node_modules/@nowaki-dev/runtime").exists()
}

#[test]
fn build_produces_expected_manifest_and_zero_js_live_island() {
    let root = example_root();
    if !deps_installed(&root) {
        eprintln!("skip: examples/hello deps not installed");
        return;
    }
    let bin = env!("CARGO_BIN_EXE_nowaki");
    let _ = std::fs::remove_dir_all(root.join("dist"));
    let status = Command::new(bin)
        .arg("build")
        .arg(&root)
        .status()
        .expect("run nowaki build");
    assert!(status.success(), "nowaki build failed");

    let client = root.join("dist/client");
    let manifest = std::fs::read_to_string(client.join("manifest.json")).expect("manifest");
    assert!(manifest.contains("\"preload\""), "preload chains expected");

    // Jetstream island: registered, but no client chunk is emitted (zero added JS).
    assert!(
        manifest.contains("\"liveIslands\": [\"LiveCounter\", \"LiveTicks\", \"LiveTodos\"]"),
        "LiveCounter, LiveTicks, and LiveTodos should be live islands"
    );
    assert!(
        manifest.contains("\"liveRuntime\""),
        "liveRuntime (live.js) expected"
    );
    let names: Vec<String> = std::fs::read_dir(&client)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert!(
        !names.iter().any(|n| n.starts_with("LiveCounter.")),
        "live island must not ship a client chunk"
    );
    // Scope hoisting: the cyclic lib (cycle-a) doesn't become its own chunk (concatenated into Cycle).
    assert!(
        !names.iter().any(|n| n.starts_with("cycle-a.")),
        "cyclic lib should be hoisted, not a separate chunk"
    );
    // Live islands are still emitted as server modules (needed for re-rendering).
    assert!(
        root.join("dist/server/islands/LiveCounter.js").exists(),
        "live island server module expected"
    );

    // Server functions: the allowlist (dist/server/functions.json) lists actions/todos' exports.
    let functions =
        std::fs::read_to_string(root.join("dist/server/functions.json")).expect("functions.json");
    for export in ["addTodo", "listTodos", "whoami"] {
        assert!(
            functions.contains(&format!("\"export\": \"{export}\"")),
            "server function {export} should be in functions.json"
        );
    }
    assert!(
        functions.contains("\"module\": \"actions/todos.js\""),
        "functions.json module should point at the built server module"
    );

    // The implementation never reaches the client (no server-only secret/store in the bundle).
    for chunk in &names {
        if chunk.ends_with(".js") {
            let body = std::fs::read_to_string(client.join(chunk)).unwrap_or_default();
            assert!(
                !body.contains("nowaki-server-only-secret"),
                "server secret leaked into client chunk {chunk}"
            );
        }
    }

    // The island chunk imports a proxy in a separate chunk (todos.*.js), not the server function body.
    let todos_proxy = names
        .iter()
        .find(|n| n.starts_with("todos.") && n.ends_with(".js"))
        .expect("server-fn proxy chunk (todos.*.js) expected");
    let proxy = std::fs::read_to_string(client.join(todos_proxy)).unwrap();
    assert!(
        proxy.contains("__nowakiCall(") && proxy.contains("/__nowaki/fn"),
        "proxy chunk should be the fetch shim, not the impl"
    );
    // The proxy's id matches the id in functions.json (computed independently on client and server).
    for id in ["675f80133a1699f8", "6c90d7dc921a9a3f", "781de5a7f5ba2469"] {
        assert!(functions.contains(id), "functions.json missing id {id}");
        assert!(proxy.contains(id), "proxy missing id {id}");
    }

    // `<form action={fn}>`: the proxy's toString returns "__nowaki_action:<id>" for form interception to pick up.
    assert!(
        functions.contains("\"export\": \"addTodoForm\""),
        "addTodoForm (form-action server fn) should be in functions.json"
    );
    assert!(
        proxy.contains("__nowaki_action:"),
        "proxy should expose a form-action sentinel via toString"
    );
    // The islands runtime chunk bundles form interception.
    assert!(
        names.iter().any(|n| {
            n.starts_with("islands.")
                && n.ends_with(".js")
                && std::fs::read_to_string(client.join(n))
                    .map(|s| s.contains("__nowaki_action:"))
                    .unwrap_or(false)
        }),
        "islands runtime should ship the <form action> interceptor"
    );

    // Virtual modules (plugin resolveId/load):
    // on the client the generated source is concatenated into the island chunk; no bare `virtual:` specifier remains.
    let vbadge = names
        .iter()
        .find(|n| n.starts_with("VirtualBadge.") && n.ends_with(".js"))
        .expect("VirtualBadge client chunk expected");
    let vbody = std::fs::read_to_string(client.join(vbadge)).unwrap();
    assert!(
        vbody.contains("VIRTUAL_OK"),
        "virtual module source should be bundled into the island chunk"
    );
    assert!(
        !vbody.contains("virtual:build-info"),
        "bare virtual specifier should be inlined, not left as an import"
    );
    // SSR: inlined as a data: module (Node can import it directly).
    let vserver =
        std::fs::read_to_string(root.join("dist/server/islands/VirtualBadge.js")).unwrap();
    assert!(
        vserver.contains("data:text/javascript,"),
        "virtual module should be inlined as a data: module for SSR"
    );
    assert!(
        !vserver.contains("\"virtual:build-info\""),
        "no raw virtual specifier should remain in the server module"
    );

    let _ = std::fs::remove_dir_all(root.join("dist"));
}
