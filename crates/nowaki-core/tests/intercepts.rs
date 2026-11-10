//! nowaki_core::routes::intercept_target against the fixture scripts/router-test.mjs runs on
//! router.mjs `interceptTarget`: typegen / prerender and the runtime must agree on what an
//! intercepting route takes over.

use nowaki_core::routes::intercept_target;
use serde_json::Value;

#[test]
fn shared_fixture() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/intercept-cases.json"
    );
    let fixture: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    assert!(!cases.is_empty());
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let owner: Vec<&str> = case["owner"]
            .as_str()
            .unwrap()
            .split('/')
            .filter(|p| !p.is_empty())
            .collect();
        let inner: Vec<&str> = case["inner"].as_str().unwrap().split('/').collect();
        assert_eq!(
            intercept_target(&owner, &inner).as_deref(),
            case["target"].as_str(),
            "{name}"
        );
    }
}
