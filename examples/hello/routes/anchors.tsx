import Counter from "../islands/Counter.tsx";

export const title = "Anchors — Nowaki";

// A long page with fragment targets (an id and a legacy <a name>), for the client router's
// scroll tests: /anchors#two from another page, same-page hash links, back/forward.
const tall = "min-height:1500px;border-top:1px solid #ddd";

export default function Anchors() {
  return (
    <main style="font-family:sans-serif;max-width:640px;margin:2rem auto">
      <h1>Anchors</h1>
      <Counter />
      <p>
        <a href="#two">two</a> / <a href="#three">three</a>
      </p>
      <section id="one" style={tall}>One</section>
      <section id="two" style={tall}>Two</section>
      <a name="named" />
      <section id="three" style={tall}>Three</section>
    </main>
  );
}
