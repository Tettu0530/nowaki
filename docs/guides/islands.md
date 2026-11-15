# Islands and hydration

Pages, layouts and components render to HTML on the server and send no JavaScript. The
interactive parts are **islands**: components in `islands/` that also run in the browser. A page
that renders an island ships that island's code, Preact and the small islands runtime; a page
without islands ships no JavaScript at all.

There are two kinds of islands:

- **Client islands** (this guide): the component hydrates in the browser and keeps its state
  there, like any Preact component.
- **Live islands** (`export const live`): the server holds the state and sends HTML patches; no
  component code reaches the browser. See [Jetstream live islands](./jetstream.md).

## A client island

```tsx
// islands/Counter.tsx
import { useState } from "preact/hooks";

export default function Counter({ start = 0 }: { start?: number }) {
  const [count, setCount] = useState(start);
  return (
    <div>
      <button onClick={() => setCount((c) => c - 1)}>-</button>
      <strong>{count}</strong>
      <button onClick={() => setCount((c) => c + 1)}>+</button>
    </div>
  );
}
```

```tsx
// routes/index.tsx
import Counter from "../islands/Counter.tsx";

export default function Home() {
  return (
    <main>
      <h1>Home</h1>
      <Counter start={10} />
    </main>
  );
}
```

- An island is the default export of a file under `islands/`. Import it with the file
  extension.
- Write Preact: hooks come from `preact/hooks`. Imports of `react`, `react-dom` and
  `react/jsx-runtime` resolve to `preact/compat`, so many React libraries work.
- Hooks and event handlers only work in islands. In a page, layout or `components/` file they
  render once on the server and do nothing in the browser.
- The island is rendered on the server first (its HTML is in the page), then hydrated.

### Props

Props go from the server to the browser as JSON in the page's HTML. Pass data: strings,
numbers, booleans, arrays and plain objects. Functions are dropped, `undefined` fields are left
out, and a `Date` arrives as its ISO string. Everything in the props is visible in the page
source, so never pass secrets.

## Hydration strategies

A `client:*` directive where the island is used decides when it hydrates:

| Directive | Hydrates |
| --- | --- |
| `client:load` (default) | as soon as the page loads |
| `client:idle` | when the browser is idle (`requestIdleCallback`) |
| `client:visible` | when it scrolls into view (`IntersectionObserver`) |
| `client:media="(min-width: 768px)"` | when the media query matches |
| `client:only` | in the browser only; the server renders nothing for it |

```tsx
<Counter start={0} />                          {/* client:load */}
<Counter start={10} client:idle />
<Chart client:visible />
<MobileMenu client:media="(max-width: 767px)" />
<Map client:only />                             {/* uses window at render time */}
```

- The directives are typed by the scaffold's `nowaki-jsx.d.ts` and are not passed to the
  component as props.
- Use `client:visible` or `client:idle` for islands below the fold or not needed right away:
  they don't compete with the first render.
- Use `client:only` for components that touch browser-only APIs while rendering. It shows
  nothing until the code loads, so reserve space for it in CSS to avoid layout shift.

Working example: `examples/hello/routes/lazy.tsx`.

## Islands and client navigation

On a page with islands, the client router handles same-origin links (see
[Routing: client navigation](./routing.md#client-navigation)). It swaps the page body and
hydrates the new page's islands. Islands do not keep their state across a navigation, except
in a parallel-route slot that an intercepting route fills: there the rest of the page stays.

## Page scripts

For browser code that isn't a component (a carousel library, analytics, a scroll effect), a page
or layout can list modules in `export const scripts`. Each is bundled like an island (npm imports
included) and loaded as `<script type="module">`, with no hydration.

```tsx
// routes/scripted.tsx
export const scripts = ["../scripts/stamp.ts"];

export default function Scripted() {
  return <p id="script-stamp"></p>;
}
```

```ts
// scripts/stamp.ts
function stamp() {
  const host = document.getElementById("script-stamp");
  if (host) host.textContent = "ran in the browser";
}
stamp();
// A module runs once. After a client navigation, set up the new page again:
document.addEventListener("nowaki:page-load", stamp);
```

- The list is read from the source at build time: it must be an array of string literals
  (relative paths from the file, or package names). A missing module fails the build.
- A layout's scripts come before the page's; a module listed twice loads once.
- Scripts count toward the page's first-load JS and `budget`.

Working example: `examples/hello/routes/scripted.tsx` with `examples/hello/scripts/stamp.ts`.

## JS budgets

`export const budget = { js: 12 }` on a page caps its first-load JavaScript at 12 KB gzip (the
islands runtime, the islands the page can render, page scripts, and the live runtime).
`nowaki build` fails when the page goes over it; `0` means no client JS. The value must be a
number literal. The build report prints each route's first-load JS, and the dev toolbar shows
the page against its budget.

The build report also points out client islands that could ship no JavaScript: ones that only
keep state and handle clicks or forms (a live island does that on the server), and ones with no
state or events at all. `NOWAKI_HINTS=0` hides these hints.

Working example: `examples/gallery/routes/posts/[id].tsx`.

## Edge cases

- An island's imports are bundled for the browser. Importing a server-only module from an
  island (`@nowaki-dev/runtime/env/server`, `nonce()`) fails the build or does nothing useful;
  call a [server function](./data.md#server-functions) instead.
- Only `import.meta.env.PUBLIC_*` and `import.meta.env.MODE` are inlined into island code.
- A CSS file or CSS Module an island imports is loaded with it.
- `.tsrx` islands compile with the app's `@tsrx/preact` (see
  `examples/hello/islands/TsrxCounter.tsrx`).

## Reference

- [Route module exports](../reference/route-exports.md) (`scripts`, `budget`, `IslandModule`)
- [Client events and attributes](../reference/client-events.md) (`client:*`, `nowaki:page-load`)
- [File conventions](../reference/file-conventions.md) (`islands/`)
