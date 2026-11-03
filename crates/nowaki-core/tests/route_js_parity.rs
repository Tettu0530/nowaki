use std::path::PathBuf;
use std::process::Command;

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("workspace root")
}

#[test]
fn page_urls_match_router_scan_routes() {
    let root = workspace_root();
    let app = root.join("examples/hello");
    let routes_dir = app.join("routes");
    let rust_urls = nowaki_core::routes::page_url_patterns(&routes_dir).expect("scan routes");
    let script = root.join("scripts/route-enumeration-parity.mjs");
    let output = Command::new("node")
        .arg(&script)
        .arg(&app)
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
