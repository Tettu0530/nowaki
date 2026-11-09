//! `NowakiCore::set_base_path`: emitted asset URLs, server function proxies and
//! `import.meta.env.BASE_URL` follow nowaki.config `basePath`.

use std::fs;
use std::path::Path;

use nowaki_core::NowakiCore;

fn app(name: &str) -> std::path::PathBuf {
    let root = std::env::temp_dir().join(format!("nowaki-base-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    for d in ["lib", "assets", "islands", "actions"] {
        fs::create_dir_all(root.join(d)).unwrap();
    }
    fs::write(root.join("assets/logo.svg"), "<svg/>").unwrap();
    fs::write(
        root.join("lib/logo.ts"),
        "import logo from \"../assets/logo.svg\";\nexport const src = logo;\nexport const base = import.meta.env.BASE_URL;\n",
    )
    .unwrap();
    fs::write(
        root.join("actions/hi.ts"),
        "\"use server\";\nexport async function hi() { return 1; }\n",
    )
    .unwrap();
    fs::write(
        root.join("islands/Hi.tsx"),
        "import { hi } from \"../actions/hi.ts\";\nimport logo from \"../assets/logo.svg\";\nexport default function Hi() {\n  return <button onClick={() => hi()} data-base={import.meta.env.BASE_URL}><img src={logo} /></button>;\n}\n",
    )
    .unwrap();
    root
}

fn client_js(root: &Path) -> String {
    let mut all = String::new();
    for e in fs::read_dir(root.join("dist/client")).unwrap().flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.ends_with(".js") {
            all.push_str(&fs::read_to_string(e.path()).unwrap());
        }
    }
    all
}

#[test]
fn urls_follow_the_base_path() {
    let root = app("on");
    let mut core = NowakiCore::new(root.clone());
    core.set_base_path("/app").unwrap();
    assert_eq!(core.base_path(), "/app");
    assert_eq!(core.asset_base(), "/app/_nowaki/");
    core.build(&root.join("dist")).expect("build ok");
    let server = fs::read_to_string(root.join("dist/server/lib/logo.js")).unwrap();
    let client = client_js(&root);
    let _ = fs::remove_dir_all(&root);

    // Server modules hold asset URLs inside percent-encoded data: modules.
    assert!(server.contains("%2Fapp%2F_nowaki%2Flogo."), "{server}");
    assert!(
        server.contains("\"/app/\""),
        "BASE_URL in the server build:\n{server}"
    );
    assert!(client.contains("/app/__nowaki/fn"), "{client}");
    assert!(client.contains("/app/_nowaki/logo."), "{client}");
    assert!(
        client.contains("\"/app/\"") || client.contains("`/app/`"),
        "{client}"
    );
    assert!(!client.contains("import.meta.env"), "{client}");
}

#[test]
fn without_a_base_path_urls_stay_at_the_root() {
    let root = app("off");
    let mut core = NowakiCore::new(root.clone());
    assert_eq!(core.asset_base(), "/_nowaki/");
    core.build(&root.join("dist")).expect("build ok");
    let client = client_js(&root);
    // Setting "" is the same as never setting it.
    core.set_base_path("").unwrap();
    assert_eq!(core.asset_base(), "/_nowaki/");
    let _ = fs::remove_dir_all(&root);
    assert!(client.contains("\"/__nowaki/fn\""), "{client}");
    assert!(client.contains("/_nowaki/logo."), "{client}");
    assert!(!client.contains("/app/"), "{client}");
}

#[test]
fn an_invalid_base_path_is_refused() {
    let mut core = NowakiCore::new(std::env::temp_dir().join("nowaki-base-invalid"));
    for bad in ["app", "/app/", "/a\"b", "/__nowaki", "/a//b"] {
        assert!(core.set_base_path(bad).is_err(), "{bad}");
    }
    assert_eq!(core.base_path(), "");
}
