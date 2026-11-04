//! Assets imported only from server modules must be emitted to dist/client with a hash.

use std::fs;

use nowaki_core::NowakiCore;

#[test]
fn server_only_asset_is_emitted_with_a_hashed_url() {
    let root = std::env::temp_dir().join(format!("nowaki-server-asset-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("lib")).unwrap();
    fs::create_dir_all(root.join("assets")).unwrap();
    fs::write(root.join("assets/font.woff2"), b"wOF2 test font bytes").unwrap();
    fs::write(
        root.join("lib/style.ts"),
        "import fontUrl from \"../assets/font.woff2\";\nexport const css = `@font-face{src:url(${fontUrl})}`;\n",
    )
    .unwrap();

    NowakiCore::new(root.clone())
        .build(&root.join("dist"), Default::default())
        .expect("build ok");
    let server = fs::read_to_string(root.join("dist/server/lib/style.js")).unwrap();
    let emitted: Vec<String> = fs::read_dir(root.join("dist/client"))
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("font.") && n.ends_with(".woff2"))
        .collect();
    let _ = fs::remove_dir_all(&root);

    assert_eq!(
        emitted.len(),
        1,
        "font not emitted to dist/client: {emitted:?}"
    );
    let name = &emitted[0];
    assert_ne!(name, "font.woff2", "emitted name must carry a content hash");
    // The URL sits inside a percent-encoded data: module.
    assert!(
        server.contains(&format!("%2F_nowaki%2F{name}")),
        "server module must reference the emitted file /_nowaki/{name}:\n{server}"
    );
}
