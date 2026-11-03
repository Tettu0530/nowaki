// Client-navigation target with its own <style> and <html lang>. The browser router test checks
// both are applied when arriving here via the SPA router, and dropped again when leaving.
export const title = "Styled — Nowaki";
export const lang = "ja";
export const head = `<style>#styled-probe{color:rgb(1, 2, 3)}</style>`;

export default function Styled() {
  return (
    <main>
      <h1 id="styled-probe">Styled</h1>
    </main>
  );
}
