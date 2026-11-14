//! Checks that Rust `page_url_patterns` / `slot_route_patterns` match `scanRoutes` (router.mjs) on
//! `examples/hello`. Lives in the CLI crate so `nowaki-core` stays JS-free in its test suite.

use std::path::PathBuf;
use std::process::Command;

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

#[derive(serde::Deserialize)]
struct JsRoutes {
    pages: Vec<String>,
    slots: Vec<String>,
}

#[test]
fn page_urls_match_router_scan_routes() {
    let root = workspace_root();
    let routes_dir = root.join("examples/hello/routes");
    let rust_urls = nowaki_core::routes::page_url_patterns(&routes_dir).expect("scan routes");
    let rust_slots = nowaki_core::routes::slot_route_patterns(&routes_dir).expect("scan slots");
    // Relative script path + cwd avoids Windows `\\?\` canonical paths breaking Node's argv parsing.
    let output = Command::new("node")
        .current_dir(&root)
        .arg("scripts/route-enumeration-parity.mjs")
        .arg("examples/hello")
        .output()
        .expect("node route-enumeration-parity.mjs");
    assert!(
        output.status.success(),
        "route-enumeration-parity.mjs failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let js: JsRoutes = serde_json::from_slice(&output.stdout).expect("parity script stdout JSON");
    assert_eq!(
        rust_urls, js.pages,
        "Rust page_url_patterns must match scanRoutes (router.mjs)"
    );
    assert!(
        !rust_slots.is_empty(),
        "examples/hello has a parallel-route slot"
    );
    assert_eq!(
        rust_slots, js.slots,
        "Rust slot_route_patterns must match scanRoutes slots (router.mjs)"
    );
}
