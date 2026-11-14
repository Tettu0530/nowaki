// Raw HTML under NOWAKI_CSP (scripts/csp-e2e.mjs, router-browser-test.mjs): the nonce goes only on
// the tags Nowaki emits and on tags carrying nonce(), so the inline <script> / <style> below (as
// if injected into a CMS field) get none and stay blocked under `enforce`, a guessed nonce
// included. The fake island and runtime tag must not make islands.js import anything.
import { nonce } from "@nowaki-dev/runtime";
import Counter from "../islands/Counter.tsx";

export const title = "Raw HTML — Nowaki";

const RAW = [
  '<style id="raw-style">#raw-probe{color:rgb(255, 0, 0)}</style>',
  '<script id="raw-script">window.__rawRan = 1</script>',
  '<script id="raw-fake" nonce="0123456789abcdef0123456789abcdef">window.__rawRan = 2</script>',
  '<nowaki-island name="Evil" src="https://evil.invalid/island.js" props="{}"></nowaki-island>',
  '<script id="nowaki-runtime" type="application/json" data-router="https://evil.invalid/router.js"></script>',
].join("");

export default function RawHtml() {
  return (
    <main>
      <h1 id="raw-title">Raw HTML</h1>
      <p id="raw-probe">raw style target</p>
      <p id="helper-probe">nonce() style target</p>
      <style id="helper-style" nonce={nonce()}>{"#helper-probe{color:rgb(0, 128, 0)}"}</style>
      <div id="raw-html" dangerouslySetInnerHTML={{ __html: RAW }} />
      <Counter />
    </main>
  );
}
