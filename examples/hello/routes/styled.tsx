// Client-navigation target with its own <style> and <html lang>. The browser router test checks
// both are applied when arriving here via the SPA router, and dropped again when leaving.
export const title = "Styled — Nowaki";
export const lang = "ja";
// <html> / <body> attributes (merged over the root layout's bodyAttrs). `onload` is ignored:
// no inline event handlers from page exports.
export const htmlAttrs = { "data-sheet-rev": 3, "data-theme": "paper", hidden: false };
export const bodyAttrs = { class: "styled-page", onload: "alert(1)", "data-quote": '"<x>"' };
// A plain .css import's default export is its text, so it can be inlined as well as linked.
import inline from "./styled-inline.css";
import "./styled.css";
import { nonce } from "@nowaki-dev/runtime";

// An inline <style> needs the response's CSP nonce under NOWAKI_CSP: nonce() in meta(), which runs
// per request (a static `head` string gets no nonce).
export const meta = () => ({ head: `<style nonce="${nonce()}">${inline.trim()}</style>` });

export default function Styled() {
  return (
    <main>
      <h1 id="styled-probe">Styled</h1>
      <p id="styled-linked">linked stylesheet</p>
    </main>
  );
}
