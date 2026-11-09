//! Remote `?image` imports through every transform mode, with a fake fetcher (no network).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use nowaki_core::remote_image::RemoteRequest;
use nowaki_core::{Mode, NowakiCore, RemoteFetch, RemoteImages, RemotePattern};

/// Serves `examples/hello/photo.png` (256×256) for every request and records the URLs.
#[derive(Default)]
struct Fake {
    calls: AtomicUsize,
    urls: Mutex<Vec<String>>,
}

impl RemoteFetch for Fake {
    fn fetch(&self, _: &[RemotePattern], reqs: &[RemoteRequest]) -> Vec<anyhow::Result<()>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let png = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/hello/photo.png");
        reqs.iter()
            .map(|r| {
                self.urls.lock().unwrap().push(r.url.clone());
                fs::create_dir_all(&r.dir)?;
                let file = format!("{}.png", r.stem);
                fs::copy(&png, r.dir.join(&file))?;
                fs::write(
                    r.dir.join("meta.json"),
                    serde_json::json!({ "url": r.url, "file": file }).to_string(),
                )?;
                Ok(())
            })
            .collect()
    }
}

fn temp_app(name: &str, files: &[(&str, &str)]) -> PathBuf {
    let root = std::env::temp_dir().join(format!("nowaki-remote-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    for (rel, src) in files {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, src).unwrap();
    }
    dunce::canonicalize(&root).unwrap()
}

fn patterns() -> Vec<RemotePattern> {
    vec![RemotePattern {
        protocol: Some("https".into()),
        hostname: "img.test".into(),
        port: None,
        pathname: Some("/p/**".into()),
    }]
}

fn core_with(root: &Path, fake: &Arc<Fake>) -> NowakiCore {
    let mut core = NowakiCore::new(root.to_path_buf());
    core.set_remote_images(Arc::new(RemoteImages::new(
        root.to_path_buf(),
        patterns(),
        Some(fake.clone()),
    )));
    core
}

fn client_files(root: &Path) -> Vec<String> {
    fs::read_dir(root.join("dist/client"))
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect()
}

#[test]
fn a_build_fetches_every_remote_image_once_and_reuses_the_cache() {
    let root = temp_app(
        "build",
        &[
            (
                "islands/Hero.tsx",
                "import hero from \"https://img.test/p/hero.png?image&w=100\";\nexport default function Hero() { return <img src={hero.src} />; }\n",
            ),
            (
                "routes/index.tsx",
                "import Hero from \"../islands/Hero.tsx\";\nimport other from \"https://img.test/p/other.png?v=2&image\";\nexport default function Page() { return <main><Hero client:load /><img src={other.src} /></main>; }\n",
            ),
            (
                "routes/post.mdx",
                "# Post\n\n![remote](https://img.test/p/mdx.png)\n\n![not allowed](https://elsewhere.test/x.png)\n",
            ),
        ],
    );
    let fake = Arc::new(Fake::default());
    core_with(&root, &fake)
        .build(&root.join("dist"))
        .expect("build ok");
    assert_eq!(fake.calls.load(Ordering::SeqCst), 1, "one batched fetch");
    let mut urls = fake.urls.lock().unwrap().clone();
    urls.sort();
    assert_eq!(
        urls,
        [
            "https://img.test/p/hero.png",
            "https://img.test/p/mdx.png",
            "https://img.test/p/other.png?v=2"
        ]
    );
    let files = client_files(&root);
    assert!(
        files
            .iter()
            .any(|f| f.starts_with("hero-100.") && f.ends_with(".avif")),
        "{files:?}"
    );
    assert!(
        files.iter().any(|f| f.starts_with("other-256.")),
        "{files:?}"
    );
    let page = fs::read_to_string(root.join("dist/server/routes/index.js")).unwrap();
    assert!(page.contains("other-256."), "{page}");
    assert!(
        !page.contains("img.test"),
        "the URL must not reach the output:\n{page}"
    );
    let post = fs::read_to_string(root.join("dist/server/routes/post.js")).unwrap();
    assert!(post.contains("mdx-256."), "{post}");
    assert!(post.contains("https://elsewhere.test/x.png"), "{post}");

    // Everything cached: a rebuild never calls the fetcher.
    core_with(&root, &fake)
        .build(&root.join("dist"))
        .expect("rebuild ok");
    assert_eq!(
        fake.calls.load(Ordering::SeqCst),
        1,
        "a cache hit never fetches"
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn a_remote_image_the_patterns_do_not_allow_fails_the_build_without_a_fetch() {
    for (name, spec) in [
        ("host", "https://evil.test/p/a.png?image"),
        ("path", "https://img.test/private/a.png?image"),
        ("protocol", "http://img.test/p/a.png?image"),
        ("traversal", "https://img.test/p/../private/a.png?image"),
        ("userinfo", "https://img.test@evil.test/p/a.png?image"),
    ] {
        let root = temp_app(
            &format!("deny-{name}"),
            &[(
                "routes/index.tsx",
                &format!(
                    "import img from \"{spec}\";\nexport default () => <img src={{img.src}} />;\n"
                ),
            )],
        );
        let fake = Arc::new(Fake::default());
        let Err(err) = core_with(&root, &fake).build(&root.join("dist")) else {
            panic!("{spec}: the build should fail");
        };
        assert!(
            format!("{err:#}").contains("not allowed by images.remotePatterns"),
            "{spec}: {err:#}"
        );
        assert_eq!(fake.calls.load(Ordering::SeqCst), 0, "{spec}");
        let _ = fs::remove_dir_all(&root);
    }

    // No patterns at all: refused too.
    let root = temp_app(
        "deny-none",
        &[(
            "routes/index.tsx",
            "import img from \"https://img.test/p/a.png?image\";\nexport default () => <img src={img.src} />;\n",
        )],
    );
    let Err(err) = NowakiCore::new(root.clone()).build(&root.join("dist")) else {
        panic!("the build should fail");
    };
    assert!(
        format!("{err:#}").contains("images.remotePatterns"),
        "{err:#}"
    );
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn dev_modules_use_the_cached_download_and_report_refusals() {
    let root = temp_app(
        "dev",
        &[
            (
                "islands/A.tsx",
                "import a from \"https://img.test/p/a.png?image\";\nexport default () => <img src={a.src} />;\n",
            ),
            (
                "islands/B.tsx",
                "import b from \"https://evil.test/b.png?image\";\nexport default () => <img src={b.src} />;\n",
            ),
        ],
    );
    let fake = Arc::new(Fake::default());
    let core = core_with(&root, &fake);
    let a = root.join("islands/A.tsx");
    let browser = core.load_module(&a, Mode::Browser).unwrap();
    assert!(
        browser.contains("__nowaki%2Fimage%3Ff%3D%2Fnode_modules%2F.cache"),
        "{browser}"
    );
    assert!(browser.contains("width%3A%20256"), "{browser}");
    let ssr = core.load_module(&a, Mode::Ssr).unwrap();
    assert!(ssr.contains("width%3A%20256"), "{ssr}");
    assert_eq!(fake.calls.load(Ordering::SeqCst), 1);

    let b = core
        .load_module(&root.join("islands/B.tsx"), Mode::Browser)
        .unwrap();
    assert!(b.contains("throw%20new%20Error"), "{b}");
    assert!(b.contains("not%20allowed"), "{b}");
    assert_eq!(
        fake.calls.load(Ordering::SeqCst),
        1,
        "refused before any fetch"
    );
    let _ = fs::remove_dir_all(&root);
}
