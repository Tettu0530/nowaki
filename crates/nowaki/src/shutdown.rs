//! Shutdown signals for the long-running servers (`dev`, `start`).
//!
//! The process must return from `main` on SIGINT/SIGTERM rather than die, so the
//! Node children (sidecar, plugin host) are killed instead of left orphaned.

/// Resolves on Ctrl-C, or on SIGTERM on Unix (systemd, Docker, pm2, CI `kill`).
pub async fn signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
}

/// Stops a Node child: SIGTERM first (Unix) so it can flush state, such as Jetstream rooms, then a
/// kill if it is still running after `grace`. Elsewhere, or without a pid, it just kills.
pub async fn stop_child(child: &mut tokio::process::Child, grace: std::time::Duration) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        let sent = std::process::Command::new("kill")
            .arg("-TERM")
            .arg(pid.to_string())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|s| s.success());
        if sent && tokio::time::timeout(grace, child.wait()).await.is_ok() {
            return;
        }
    }
    #[cfg(not(unix))]
    let _ = grace;
    let _ = child.kill().await;
}
