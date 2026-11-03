//! A rebuild must not leave output from the previous build behind.

use std::fs;

use nowaki_core::build::build_client;
use nowaki_core::NowakiCore;

fn chunks_named(dir: &std::path::Path, stem: &str) -> Vec<String> {
    fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with(&format!("{stem}.")))
        .collect()
}

#[test]
fn rebuild_drops_chunks_of_deleted_islands() {
    let root = std::env::temp_dir().join(format!("nowaki-build-clean-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("islands")).unwrap();
    fs::write(
        root.join("islands/Keep.ts"),
        "export default function Keep() { return 1; }\n",
    )
    .unwrap();
    fs::write(
        root.join("islands/Gone.ts"),
        "export default function Gone() { return 2; }\n",
    )
    .unwrap();
    let client = root.join("dist/client");

    build_client(&NowakiCore::new(root.clone()), &root.join("dist")).expect("first build");
    assert!(!chunks_named(&client, "Gone").is_empty());

    fs::remove_file(root.join("islands/Gone.ts")).unwrap();
    build_client(&NowakiCore::new(root.clone()), &root.join("dist")).expect("second build");
    let stale = chunks_named(&client, "Gone");
    let kept = chunks_named(&client, "Keep");
    let _ = fs::remove_dir_all(&root);

    assert!(
        stale.is_empty(),
        "stale chunks of a deleted island remain: {stale:?}"
    );
    assert!(!kept.is_empty(), "the remaining island must still be built");
}
