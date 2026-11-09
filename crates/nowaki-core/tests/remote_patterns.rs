//! `images.remotePatterns` matching against the fixture shared with `server/images-fetch.mjs`
//! (`scripts/images-fetch-test.mjs`).

use nowaki_core::remote_image::is_allowed;
use nowaki_core::RemotePattern;

#[derive(serde::Deserialize)]
struct Fixture {
    groups: Vec<Group>,
}

#[derive(serde::Deserialize)]
struct Group {
    patterns: Vec<RemotePattern>,
    cases: Vec<(String, bool)>,
}

#[test]
fn matches_the_shared_fixture() {
    let text = include_str!("fixtures/remote-patterns-cases.json");
    let fixture: Fixture = serde_json::from_str(text).unwrap();
    let mut n = 0;
    for g in &fixture.groups {
        for (url, want) in &g.cases {
            assert_eq!(
                is_allowed(&g.patterns, url),
                *want,
                "{url:?} with {:?}",
                g.patterns
            );
            n += 1;
        }
    }
    assert!(n > 40);
}
