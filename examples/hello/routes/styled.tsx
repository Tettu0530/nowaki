// Client-navigation target with its own <style> and <html lang>. The browser router test checks
// both are applied when arriving here via the SPA router, and dropped again when leaving.
export const title = "Styled — Nowaki";
export const lang = "ja";
// A plain .css import's default export is its text, so it can be inlined as well as linked.
import inline from "./styled-inline.css";
import "./styled.css";

export const head = `<style>${inline.trim()}</style>`;

export default function Styled() {
  return (
    <main>
      <h1 id="styled-probe">Styled</h1>
      <p id="styled-linked">linked stylesheet</p>
    </main>
  );
}
