// A page script (`export const scripts` in routes/scripted.tsx): bundled for the browser with its
// imports (an npm package here) and loaded as <script type="module">, with no island. It runs
// once; on client navigation it gets `nowaki:page-load` to set up the new page.
import { h, render } from "preact";
import { label } from "./stamp-label.ts";

function stamp() {
  const host = document.getElementById("script-stamp");
  if (host && !host.dataset.ran) {
    host.dataset.ran = "1";
    render(h("b", null, label()), host);
  }
}
stamp();
document.addEventListener("nowaki:page-load", stamp);
