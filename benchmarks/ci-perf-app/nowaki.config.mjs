// The app behind the CI perf gate's /posts/[slug] page. ci-perf.mjs copies this directory next to
// each measured checkout and links that checkout's examples/hello/node_modules into it, so every
// side renders the same app with its own binary and runtime.
export default { site: "https://perf.nowaki.dev" };
