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
    let live_list = manifest
        .split("\"liveIslands\": [")
        .nth(1)
        .and_then(|rest| rest.split(']').next())
        .unwrap_or("");
    assert!(
        live_list.contains("\"LiveCounter\""),
        "LiveCounter should be a live island: [{live_list}]"
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

/// A small app next to examples/hello (sharing its node_modules) with one island page.
fn budget_app(budget: &str) -> tempfile::TempDir {
    let root = example_root();
    let dir = tempfile::Builder::new()
        .prefix("budget-app-")
        .tempdir_in(root.parent().unwrap())
        .expect("tempdir");
    let app = dir.path();
    std::fs::create_dir_all(app.join("routes")).unwrap();
    std::fs::create_dir_all(app.join("islands")).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(root.join("node_modules"), app.join("node_modules")).unwrap();
    #[cfg(windows)]
    std::os::windows::fs::symlink_dir(root.join("node_modules"), app.join("node_modules")).unwrap();
    std::fs::write(app.join("package.json"), r#"{"type":"module"}"#).unwrap();
    std::fs::write(
        app.join("islands/Clock.tsx"),
        "import { useState } from \"preact/hooks\";\nexport default function Clock() { const [n, set] = useState(0); return <button onClick={() => set(n + 1)}>{n}</button>; }\n",
    )
    .unwrap();
    std::fs::write(
        app.join("routes/index.tsx"),
        format!("import Clock from \"../islands/Clock.tsx\";\nexport const budget = {budget};\nexport default function Home() {{ return <Clock />; }}\n"),
    )
    .unwrap();
    std::fs::write(
        app.join("routes/about.tsx"),
        "export const budget = { js: 0.1 };\nexport default function About() { return <p>about</p>; }\n",
    )
    .unwrap();
    dir
}

#[test]
fn build_reports_route_js_and_fails_over_budget() {
    let root = example_root();
    if !deps_installed(&root) {
        eprintln!("skip: examples/hello deps not installed");
        return;
    }
    let bin = env!("CARGO_BIN_EXE_nowaki");

    let ok = budget_app("{ js: 100 }");
    let out = Command::new(bin)
        .arg("build")
        .arg(ok.path())
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        out.status.success(),
        "within budget must build: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        stdout.contains("first-load JS per route"),
        "the report is always printed:\n{stdout}"
    );
    let report = std::fs::read_to_string(ok.path().join("dist/route-js.json")).unwrap();
    assert!(
        report.contains("\"url\": \"/\"") && report.contains("\"Clock\""),
        "{report}"
    );
    // A page with no islands ships no JS, so even a tiny budget passes.
    assert!(report.contains("\"url\": \"/about\""), "{report}");

    let over = budget_app("{ js: 0.5 }");
    let out = Command::new(bin)
        .arg("build")
        .arg(over.path())
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(!out.status.success(), "over budget must fail the build");
    assert!(stderr.contains("over their JS budget"), "{stderr}");

    let typo = budget_app("{ js: \"8\" }");
    let out = Command::new(bin)
        .arg("build")
        .arg(typo.path())
        .output()
        .unwrap();
    assert!(
        !out.status.success(),
        "an unreadable budget must fail, not be ignored"
    );
    assert!(String::from_utf8_lossy(&out.stderr).contains("budget.js"));
}

#[test]
fn build_hints_at_islands_that_could_ship_no_js() {
    let root = example_root();
    if !deps_installed(&root) {
        eprintln!("skip: examples/hello deps not installed");
        return;
    }
    let bin = env!("CARGO_BIN_EXE_nowaki");
    // Its own app: tests run in parallel, and another one rebuilds examples/hello.
    let app = budget_app("{ js: 100 }");
    std::fs::write(
        app.path().join("islands/Tag.tsx"),
        "export default function Tag() { return <span>v1</span>; }\n",
    )
    .unwrap();
    std::fs::write(
        app.path().join("islands/Width.tsx"),
        "import { useEffect, useState } from \"preact/hooks\";\nexport default function Width() { const [w, set] = useState(0); useEffect(() => set(innerWidth), []); return <b onClick={() => set(0)}>{w}</b>; }\n",
    )
    .unwrap();
    let out = Command::new(bin)
        .arg("build")
        .arg(app.path())
        .output()
        .expect("run nowaki build");
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        stdout.contains("islands/Clock.tsx could be a live island (useState, onClick)"),
        "{stdout}"
    );
    assert!(
        stdout.contains("islands/Tag.tsx has no state or event handlers"),
        "{stdout}"
    );
    // An island that needs the browser (useEffect) gets no hint.
    assert!(!stdout.contains("islands/Width.tsx"), "{stdout}");

    let quiet = Command::new(bin)
        .arg("build")
        .arg(app.path())
        .env("NOWAKI_HINTS", "0")
        .output()
        .expect("run nowaki build");
    assert!(!String::from_utf8_lossy(&quiet.stdout).contains("could be a live island"));
}

#[test]
fn build_fails_on_an_invalid_content_entry() {
    let root = example_root();
    if !deps_installed(&root) {
        eprintln!("skip: examples/hello deps not installed");
        return;
    }
    let bin = env!("CARGO_BIN_EXE_nowaki");
    let app = budget_app("{ js: 100 }");
    let c = app.path().join("content");
    std::fs::create_dir_all(c.join("posts")).unwrap();
    std::fs::write(
        c.join("config.ts"),
        r#"import { defineCollection } from "@nowaki-dev/runtime/content";
const post = { "~standard": { version: 1, vendor: "test", validate: (v: any) =>
  typeof v?.title === "string" ? { value: v } : { issues: [{ message: "is required", path: ["title"] }] } } };
export const posts = defineCollection({ schema: post });
"#,
    )
    .unwrap();
    std::fs::write(c.join("posts/good.md"), "---\ntitle: Good\n---\n# Good\n").unwrap();
    let ok = Command::new(bin)
        .arg("build")
        .arg(app.path())
        .output()
        .unwrap();
    assert!(
        ok.status.success(),
        "{}",
        String::from_utf8_lossy(&ok.stderr)
    );
    assert!(String::from_utf8_lossy(&ok.stdout).contains("content: 1 entries checked"));

    std::fs::write(c.join("posts/bad.md"), "---\nauthor: x\n---\nno title\n").unwrap();
    let bad = Command::new(bin)
        .arg("build")
        .arg(app.path())
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&bad.stderr);
    assert!(
        !bad.status.success(),
        "an invalid entry must fail the build"
    );
    assert!(
        stderr.contains("content/posts/bad.md: title: is required"),
        "{stderr}"
    );
}

#[test]
fn prerender_refuses_an_out_that_is_the_build() {
    let root = example_root();
    if !deps_installed(&root) {
        eprintln!("skip: examples/hello deps not installed");
        return;
    }
    let bin = env!("CARGO_BIN_EXE_nowaki");
    let app = budget_app("{ js: 100 }");
    let built = Command::new(bin)
        .arg("build")
        .arg(app.path())
        .output()
        .unwrap();
    assert!(built.status.success());
    for out in ["dist", "dist/", "dist/server"] {
        let run = Command::new(bin)
            .arg("prerender")
            .arg(app.path())
            .args(["--out", out])
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&run.stderr);
        assert!(!run.status.success(), "--out {out} must be refused");
        assert!(
            stderr.to_lowercase().contains("choose another directory"),
            "{stderr}"
        );
        // The earlier build is untouched.
        assert!(
            app.path().join("dist/server/routes/index.js").is_file(),
            "--out {out}"
        );
        assert!(app.path().join("dist/client").is_dir(), "--out {out}");
    }
}

/// An app that logs ~1 MiB to stdout per render: Node's pipe writes are synchronous on Linux,
/// so prerender has to keep reading the server's stdout after READY or every request hangs. (On
/// macOS Node buffers instead; there the test still checks that the logs are passed through.)
#[test]
fn prerender_keeps_reading_a_chatty_servers_stdout() {
    let root = example_root();
    if !deps_installed(&root) {
        eprintln!("skip: examples/hello deps not installed");
        return;
    }
    let bin = env!("CARGO_BIN_EXE_nowaki");
    let app = budget_app("{ js: 100 }");
    std::fs::write(
        app.path().join("routes/about.tsx"),
        "export default function About() {\n  const line = \"x\".repeat(4096);\n  for (let i = 0; i < 256; i++) console.log(line);\n  return <p>about</p>;\n}\n",
    )
    .unwrap();
    let log = app.path().join("prerender.log");
    let mut child = Command::new(bin)
        .arg("prerender")
        .arg(app.path())
        .stdout(std::fs::File::create(&log).unwrap())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    let status = loop {
        if let Some(s) = child.try_wait().unwrap() {
            break s;
        }
        if std::time::Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("prerender hung (the server's stdout isn't being drained)");
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    };
    let out = std::fs::read_to_string(&log).unwrap();
    let tail = &out[out.len().saturating_sub(2000)..];
    assert!(status.success(), "{tail}");
    assert!(out.contains("prerender done"), "{tail}");
    assert!(app.path().join("dist/static/about/index.html").is_file());
    // The app's logs are passed through.
    assert!(out.contains(&"x".repeat(4096)));
}
