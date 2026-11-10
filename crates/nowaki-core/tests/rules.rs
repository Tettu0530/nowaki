//! nowaki_core::rules against the fixture that scripts/rules-test.mjs runs on server/rules.mjs:
//! the Rust fronts and the JS adapters must route a request the same way.

use nowaki_core::rules::{Negotiated, Outcome, RoutingConfig, Rules};
use serde_json::{json, Value};

fn outcome_json(o: &Outcome) -> Value {
    match o {
        Outcome::Redirect { status, location } => {
            json!({ "redirect": { "status": status, "location": location } })
        }
        Outcome::Rewrite(p) => json!({ "rewrite": p }),
        Outcome::Pass(p) => json!({ "pass": p }),
        Outcome::NotFound => json!({ "notFound": true }),
    }
}

fn negotiated_json(n: Option<Negotiated>) -> Value {
    match n {
        None => Value::Null,
        Some(Negotiated::Stay) => json!({ "stay": true }),
        Some(Negotiated::Redirect(location)) => {
            json!({ "redirect": { "status": 307, "location": location } })
        }
    }
}

#[test]
fn shared_fixture() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/rules-cases.json"
    );
    let fixture: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let mut failures = Vec::new();
    let mut checked = 0;
    for case in fixture["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let config: RoutingConfig = serde_json::from_value(case["config"].clone())
            .unwrap_or_else(|e| panic!("{name}: config: {e}"));
        let compiled = Rules::compile(&config);
        if case["error"].as_bool() == Some(true) {
            checked += 1;
            if compiled.is_ok() {
                failures.push(format!("{name}: compiled, expected an error"));
            }
            continue;
        }
        let rules = compiled.unwrap_or_else(|e| panic!("{name}: {e}"));
        for req in case["requests"].as_array().unwrap() {
            let method = req["method"].as_str().unwrap_or("GET");
            let path = req["path"].as_str().unwrap();
            let got = outcome_json(&rules.apply(method, path));
            checked += 1;
            if got != req["expect"] {
                failures.push(format!(
                    "{name}: {method} {path}: got {got}, want {}",
                    req["expect"]
                ));
            }
            if let Some(want) = req.get("negotiate") {
                let got = negotiated_json(rules.negotiate(
                    method,
                    path,
                    req["acceptLanguage"].as_str(),
                    req["cookie"].as_str(),
                ));
                checked += 1;
                if &got != want {
                    failures.push(format!(
                        "{name}: negotiate {method} {path} {:?} {:?}: got {got}, want {want}",
                        req["acceptLanguage"], req["cookie"]
                    ));
                }
            }
            if let Some(want) = req.get("headers") {
                let got: Vec<Value> = rules
                    .headers(path)
                    .into_iter()
                    .map(|(k, v)| json!([k, v]))
                    .collect();
                if &Value::Array(got.clone()) != want {
                    failures.push(format!("{name}: headers {path}: got {got:?}, want {want}"));
                }
            }
        }
    }
    assert!(checked > 50, "fixture looks truncated ({checked} checks)");
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn routing_json_round_trips() {
    let src = json!({
        "basePath": "/app",
        "trailingSlash": "always",
        "redirects": [{ "source": "/a", "destination": "/b", "status": 308 }],
        "rewrites": [{ "source": "/p/[id]", "destination": "/photo/[id]" }],
        "headers": [{ "source": "/", "headers": [{ "key": "x-a", "value": "1" }] }],
        "i18n": { "locales": ["en", "ja"], "defaultLocale": "en", "prefixDefaultLocale": false, "detect": true }
    });
    let config: RoutingConfig = serde_json::from_value(src.clone()).unwrap();
    assert_eq!(serde_json::to_value(&config).unwrap(), src);
    let rules = Rules::compile(&config).unwrap();
    assert!(!rules.is_empty());
    assert_eq!(rules.base_path(), "/app");
}
