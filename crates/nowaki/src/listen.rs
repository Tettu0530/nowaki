//! Where `nowaki dev` and `nowaki start` listen. Both resolve the address the same way:
//!
//! - port: `--port`, else `PORT` (what the node / bun / deno adapters read), else 3000;
//! - host: `--host <addr>`, else `--host` alone (all interfaces, `0.0.0.0`), else `NOWAKI_HOST`,
//!   else `127.0.0.1`.
//!
//! What a bind exposes is read from the socket afterwards ([`is_exposed`]), so a hostname that
//! resolves to loopback keeps the loopback-only defaults of `nowaki dev`.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use anyhow::{bail, Context, Result};

pub const DEFAULT_PORT: u16 = 3000;
pub const DEFAULT_HOST: &str = "127.0.0.1";
/// What `--host` without a value means.
pub const ALL_INTERFACES: &str = "0.0.0.0";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bind {
    pub host: String,
    pub port: u16,
}

/// Resolves the flags against `PORT` / `NOWAKI_HOST` from the environment.
pub fn resolve(port: Option<u16>, host: Option<String>) -> Result<Bind> {
    let (port_env, host_env) = (
        std::env::var("PORT").ok(),
        std::env::var("NOWAKI_HOST").ok(),
    );
    resolve_with(port, host, |k| match k {
        "PORT" => port_env.clone(),
        _ => host_env.clone(),
    })
}

fn resolve_with(
    port: Option<u16>,
    host: Option<String>,
    env: impl Fn(&str) -> Option<String>,
) -> Result<Bind> {
    let port = match port {
        Some(p) => p,
        None => match env("PORT").map(|s| s.trim().to_string()) {
            Some(s) if !s.is_empty() => s.parse::<u16>().map_err(|_| {
                anyhow::anyhow!(
                    "PORT=\"{s}\" is not a port number (0-65535).\n  → Fix PORT, or pass --port <PORT>."
                )
            })?,
            _ => DEFAULT_PORT,
        },
    };
    let host = match host {
        Some(h) => {
            check_host_flag(&h)?;
            h
        }
        None => env("NOWAKI_HOST")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| DEFAULT_HOST.to_string()),
    };
    // `[::1]` as written in a URL.
    let host = match host.strip_prefix('[').and_then(|h| h.strip_suffix(']')) {
        Some(inner) => inner.to_string(),
        None => host,
    };
    Ok(Bind { host, port })
}

/// `--host` takes an optional value, so `nowaki dev --host examples/app` reads the directory as
/// the address. Catch that instead of failing in DNS.
fn check_host_flag(h: &str) -> Result<()> {
    let looks_like_path = h.is_empty()
        || h == "."
        || h == ".."
        || h.contains('/')
        || h.contains('\\')
        || (h.parse::<IpAddr>().is_err() && std::path::Path::new(h).is_dir());
    if looks_like_path {
        bail!(
            "--host \"{h}\" is not an address. `--host` takes an optional address since 0.20.0, so a directory right after it is read as the address.\n  → Put the directory first (`nowaki dev {h} --host`), or give the address (`--host 0.0.0.0 {h}`)."
        );
    }
    Ok(())
}

/// Binds `bind`, with the fix in the error when the port is taken.
pub async fn bind(bind: &Bind) -> Result<tokio::net::TcpListener> {
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((bind.host.as_str(), bind.port))
        .await
        .with_context(|| format!("cannot resolve the listen address \"{}\"", bind.host))?
        .collect();
    match tokio::net::TcpListener::bind(&addrs[..]).await {
        Ok(l) => Ok(l),
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => bail!(
            "port {} is already in use on {}.\n  → Stop the other server, or pass --port <PORT> (or set PORT).",
            bind.port,
            bind.host
        ),
        Err(e) => Err(e).with_context(|| format!("cannot listen on {}:{}", bind.host, bind.port)),
    }
}

/// Whether a listener on `ip` is reachable from other machines: every address but loopback
/// (`0.0.0.0` / `::` included).
pub fn is_exposed(ip: IpAddr) -> bool {
    !ip.to_canonical().is_loopback()
}

/// Whether a listener on `ip` also answers on 127.0.0.1 (the address the dev renderer calls back
/// on and the MCP endpoint is shown at).
pub fn covers_loopback_v4(ip: IpAddr) -> bool {
    let ip = ip.to_canonical();
    ip == IpAddr::V4(Ipv4Addr::LOCALHOST) || ip == IpAddr::V4(Ipv4Addr::UNSPECIFIED)
}

/// `ip` as the host part of a URL (`[::1]` for IPv6).
pub fn url_host(ip: IpAddr) -> String {
    match ip.to_canonical() {
        IpAddr::V4(v4) => v4.to_string(),
        IpAddr::V6(v6) => format!("[{v6}]"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |k| {
            pairs
                .iter()
                .find(|(n, _)| *n == k)
                .map(|(_, v)| v.to_string())
        }
    }

    #[test]
    fn port_flag_wins_over_env_over_default() {
        let r = |p, e: &[(&str, &str)]| resolve_with(p, None, env(e)).unwrap().port;
        assert_eq!(r(None, &[]), 3000);
        assert_eq!(r(None, &[("PORT", "8080")]), 8080);
        assert_eq!(r(None, &[("PORT", " 8081 ")]), 8081);
        assert_eq!(r(None, &[("PORT", "")]), 3000);
        assert_eq!(r(Some(5000), &[("PORT", "8080")]), 5000);
        assert_eq!(r(None, &[("PORT", "0")]), 0);
        let err = resolve_with(None, None, env(&[("PORT", "http")])).unwrap_err();
        assert!(
            format!("{err:#}").contains("PORT=\"http\" is not a port"),
            "{err:#}"
        );
        // An invalid PORT doesn't matter when --port is given.
        assert!(resolve_with(Some(1), None, env(&[("PORT", "x")])).is_ok());
    }

    #[test]
    fn host_flag_wins_over_env_over_default() {
        let r = |h: Option<&str>, e: &[(&str, &str)]| {
            resolve_with(None, h.map(str::to_string), env(e))
                .unwrap()
                .host
        };
        assert_eq!(r(None, &[]), "127.0.0.1");
        assert_eq!(r(None, &[("NOWAKI_HOST", "0.0.0.0")]), "0.0.0.0");
        assert_eq!(r(None, &[("NOWAKI_HOST", "")]), "127.0.0.1");
        // clap turns a bare `--host` into ALL_INTERFACES.
        assert_eq!(
            r(Some(ALL_INTERFACES), &[("NOWAKI_HOST", "10.0.0.5")]),
            "0.0.0.0"
        );
        assert_eq!(
            r(Some("127.0.0.1"), &[("NOWAKI_HOST", "0.0.0.0")]),
            "127.0.0.1"
        );
        assert_eq!(r(Some("[::1]"), &[]), "::1");
        assert_eq!(r(Some("::"), &[]), "::");
        assert_eq!(r(Some("localhost"), &[]), "localhost");
    }

    #[test]
    fn a_directory_after_host_is_caught() {
        for bad in [".", "..", "examples/hello", "C:\\app", ""] {
            let err = resolve_with(None, Some(bad.to_string()), env(&[])).unwrap_err();
            assert!(
                format!("{err:#}").contains("is not an address"),
                "{bad}: {err:#}"
            );
        }
        let dir = tempfile::tempdir().unwrap();
        let name = dir.path().to_string_lossy().into_owned();
        assert!(resolve_with(None, Some(name), env(&[])).is_err());
    }

    #[test]
    fn exposure_is_read_from_the_address() {
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        assert!(!is_exposed(ip("127.0.0.1")));
        assert!(!is_exposed(ip("127.0.0.2")));
        assert!(!is_exposed(ip("::1")));
        assert!(!is_exposed(ip("::ffff:127.0.0.1")));
        assert!(is_exposed(ip("0.0.0.0")));
        assert!(is_exposed(ip("::")));
        assert!(is_exposed(ip("10.0.0.5")));
        assert!(covers_loopback_v4(ip("0.0.0.0")));
        assert!(covers_loopback_v4(ip("127.0.0.1")));
        assert!(!covers_loopback_v4(ip("10.0.0.5")));
        assert!(!covers_loopback_v4(ip("::1")));
        assert_eq!(url_host(ip("::1")), "[::1]");
        assert_eq!(url_host(ip("10.0.0.5")), "10.0.0.5");
    }

    #[tokio::test]
    async fn a_taken_port_names_the_fix() {
        let first = bind(&Bind {
            host: "127.0.0.1".into(),
            port: 0,
        })
        .await
        .unwrap();
        let port = first.local_addr().unwrap().port();
        let err = bind(&Bind {
            host: "127.0.0.1".into(),
            port,
        })
        .await
        .unwrap_err();
        let msg = format!("{err:#}");
        assert!(
            msg.contains(&format!("port {port} is already in use")),
            "{msg}"
        );
        assert!(msg.contains("--port"), "{msg}");
    }
}
