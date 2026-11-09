// The app the CI perf gate measures on every side. ci-perf.mjs copies this directory per measured
// checkout and links that checkout's examples/hello/node_modules into it, so every side builds and
// serves the same app with its own binary and runtime. Use only features 0.16.x and later support.
export default { site: "https://perf.nowaki.dev" };
