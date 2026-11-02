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
