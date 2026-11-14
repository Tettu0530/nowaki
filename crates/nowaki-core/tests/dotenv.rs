//! `.env` / `.env.local` / environment precedence against the fixture shared with
//! `server/env.mjs` `loadEnv` (`scripts/env-schema-test.mjs`).

use std::collections::BTreeMap;

use nowaki_core::env::{dotenv_values, load_client_defines};

#[derive(serde::Deserialize)]
struct Fixture {
    cases: Vec<Case>,
}

#[derive(serde::Deserialize)]
struct Case {
    name: String,
    files: BTreeMap<String, String>,
    process: BTreeMap<String, String>,
    expect: BTreeMap<String, Option<String>>,
}

fn scratch(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("nowaki-dotenv-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn matches_the_shared_fixture() {
    let text = include_str!("fixtures/dotenv-cases.json");
    let fixture: Fixture = serde_json::from_str(text).unwrap();
    assert!(!fixture.cases.is_empty());
    for (i, case) in fixture.cases.iter().enumerate() {
        let dir = scratch(&i.to_string());
        for (name, content) in &case.files {
            std::fs::write(dir.join(name), content).unwrap();
        }
        let got = dotenv_values(&dir, case.process.clone());
        for (key, want) in &case.expect {
            assert_eq!(got.get(key), want.as_ref(), "{}: {key}", case.name);
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

#[test]
fn client_defines_take_the_merged_public_values() {
    let dir = scratch("defines");
    std::fs::write(dir.join(".env"), "PUBLIC_DOTENV_X=env\nDOTENV_SECRET_X=1\n").unwrap();
    std::fs::write(dir.join(".env.local"), "PUBLIC_DOTENV_X=local\n").unwrap();
    let defines = load_client_defines(&dir);
    let get = |k: &str| defines.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
    assert_eq!(
        get("import.meta.env.PUBLIC_DOTENV_X").as_deref(),
        Some("\"local\"")
    );
    assert_eq!(get("import.meta.env.DOTENV_SECRET_X"), None);
    std::fs::remove_dir_all(&dir).unwrap();
}
