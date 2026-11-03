//! Rust `page_url_patterns` vs `scanRoutes` (router.mjs) on `examples/hello`.
//! Lives in the CLI crate so `nowaki-core` stays JS-free in its test suite.

use std::path::PathBuf;
use std::process::Command;

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

#[test]
fn page_urls_match_router_scan_routes() {
    let root = workspace_root();
    let routes_dir = root.join("examples/hello/routes");
    let rust_urls = nowaki_core::routes::page_url_patterns(&routes_dir).expect("scan routes");
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
    let js_urls: Vec<String> =
        serde_json::from_slice(&output.stdout).expect("parity script stdout JSON");
    assert_eq!(
        rust_urls, js_urls,
        "Rust page_url_patterns must match scanRoutes (router.mjs)"
    );
}
