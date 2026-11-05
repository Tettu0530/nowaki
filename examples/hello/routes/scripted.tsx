// A page with a page script and no island: scripts/stamp.ts runs in the browser and fills
// #script-stamp. The build counts it (and preact, which it imports) in this route's first-load JS.
export const title = "Scripted — Nowaki";
export const scripts = ["../scripts/stamp.ts"];

export default function Scripted() {
  return (
    <main>
      <h1>Scripted</h1>
      <p id="script-stamp"></p>
    </main>
  );
}
