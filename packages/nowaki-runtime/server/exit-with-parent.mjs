// When `nowaki` (Rust) starts this process, it passes a stdin pipe and NOWAKI_EXIT_WITH_PARENT=1.
// The pipe closes when the parent ends, however it ends (SIGKILL included, where it can't stop its
// children), so this process exits then instead of lingering with PID 1 as its parent. Run on its
// own (an adapter's `node index.mjs`), nothing changes.
if (process.env.NOWAKI_EXIT_WITH_PARENT === "1") {
  const bye = () => process.exit(0);
  process.stdin.on("end", bye);
  process.stdin.on("close", bye);
  process.stdin.on("error", bye);
  process.stdin.resume();
}
