# Jetstream live islands

A live island keeps its state on the server. The browser gets the island's HTML and a small
shared runtime (`live.js`), but none of the component's code. A click or a form submit is sent
to the server, the server runs a handler, re-renders the island and sends back an HTML patch,
which the runtime morphs into the page.

Use a live island for UI that is mostly server state (a form backed by the database, a poll, a
dashboard that updates when data changes). Use a [client island](./islands.md) for UI that must
respond without a round trip (drag and drop, a canvas, typing feedback).

## A live island

```tsx
// islands/LiveCounter.tsx
import type { Live } from "@nowaki-dev/runtime";

type State = { count: number };

export const live: Live<State> = {
  state: (props) => ({ count: props?.start ?? 0 }),
  on: {
    inc: (s) => ({ ...s, count: s.count + 1 }),
    dec: (s) => ({ ...s, count: s.count - 1 }),
    reset: () => ({ count: 0 }),
  },
};

export default function LiveCounter({ state }: { state: State }) {
  return (
    <div>
      <button data-live="dec">-</button>
      <strong>{state.count}</strong>
      <button data-live="inc">+</button>
      <button data-live="reset">reset</button>
    </div>
  );
}
```

Use it like any island: `<LiveCounter start={5} />`.

- `live.state(props)` builds the initial state from the island's props.
- `live.on` holds the event handlers. Each gets `(state, payload)` and returns the new state
  (or a promise of it).
- The component receives only `{ state }`. Keep everything the render needs in the state.
- State travels between server and browser as JSON, signed with an HMAC. A state the browser
  sends back is used only after its signature verifies, so a client can't forge it. It is not
  encrypted: the browser can read it, so keep secrets out of it.

Working examples: `examples/hello/islands/LiveCounter.tsx`, `examples/hello/routes/live.tsx`.

## Events

| Attribute | Fires on | Payload |
| --- | --- | --- |
| `data-live="handler"` | click | the element's `value`, if it has one |
| `data-live-submit="handler"` on a `<form>` | submit (no page navigation) | the form's fields as an object |
| `data-live-input="handler"` | input, debounced (`data-live-debounce="ms"`, default 150) | the field's value |
| `data-live-change="handler"` | change (blur, select, checkbox) | the value; for a checkbox or radio, `{ value, checked }` |

```tsx
<button data-live="vote" value="a">A</button>

<form data-live-submit="add">
  <input name="text" />
  <button type="submit">Add</button>
</form>

<input data-live-input="filter" data-live-debounce="100" />

<ul>
  {state.todos.map((t) => (
    <li data-key={String(t.id)}>
      <input type="checkbox" checked={t.done} data-live-change="toggle" value={String(t.id)} />
      {t.text}
    </li>
  ))}
</ul>
```

Give list rows a `data-key`: the morph matches keyed children by key, so a reorder or a filter
keeps each row's element and focus. Unkeyed children are matched by position.

Payloads come from the browser. Validate them in the handler like any request input.

Working example: `examples/hello/islands/LiveTodos.tsx` (`/live-form`).

## Authorization and the request

`getContext()` works in handlers, in `live.authorize` and while the island renders. Over the
WebSocket it returns the upgrade request's cookies and its `cookie`, `authorization`,
`accept-language` and `user-agent` headers, not the rest.

`live.authorize` runs after the signature check and before every handler. Anything but `true`
refuses the event; the client gets `{ type: "error", reason: "forbidden" }` and the island keeps
its HTML.

```tsx
import { getContext, type Live } from "@nowaki-dev/runtime";

export const live: Live<{ count: number }> = {
  state: () => ({ count: 0 }),
  on: { reset: () => ({ count: 0 }) },
  authorize: ({ handler }) => handler !== "reset" || getContext()?.cookies.role === "admin",
};
```

`ctx.session` is read-only in live renders and handlers (they can't set a cookie). Change the
session in an action, an API route or a server function.

## Live queries: `subscribe`, `load` and `publish()`

An island can subscribe to topics. When server code calls `publish(topic)`, every subscribed
island runs `live.load` and gets the new HTML pushed, without being clicked.

```tsx
// islands/LiveTicks.tsx
import type { Live } from "@nowaki-dev/runtime";
import { readTicks } from "../lib/ticks.ts";

export const live: Live<{ ticks: number }> = {
  state: () => ({ ticks: readTicks() }),
  subscribe: ["ticks"],                 // or (state) => [`post:${state.id}`]
  load: (s) => ({ ...s, ticks: readTicks() }),
  on: {},
};

export default function LiveTicks({ state }: { state: { ticks: number } }) {
  return <p>ticks: {state.ticks}</p>;
}
```

```ts
// routes/api/tick.ts
import { publish } from "@nowaki-dev/runtime";
import type { LoaderContext } from "@nowaki-dev/runtime";
import { bumpTicks } from "../../lib/ticks.ts";

export function POST(ctx: LoaderContext) {
  const ticks = bumpTicks();
  publish("ticks");
  return ctx.json({ ticks });
}
```

- Call `publish()` from actions, API routes, server functions or live handlers after data
  changes.
- A topic is 1 to 128 characters without whitespace (else a `TypeError`); an island can have at
  most 16 topics.
- A render that doesn't read the request (`getContext()`) is done once per publish and shared by
  every connection with the same state. One that reads it is rendered per connection
  (`examples/hello/islands/LiveViewer.tsx`).
- `publish()` reaches the live connections of the same `nowaki dev` / `nowaki start` process.
  On the deploy adapters it does nothing and warns once (see [Where it runs](#where-it-runs)).

Working examples: `examples/hello/islands/LiveTicks.tsx`, `examples/hello/routes/api/tick.ts`.

## Rooms and `shared`

`live.room(props)` makes a room island: every instance with the same room id shares one state,
built by `live.shared(props)`. Handlers receive and return the shared state, and every member
gets the new HTML.

```tsx
// islands/LivePoll.tsx
import type { Live } from "@nowaki-dev/runtime";

type Votes = { a: number; b: number };

// A room island needs no `state`: its handlers get the room's shared state.
export const live: Live<Votes> = {
  room: (props: { id?: string }) => `poll:${props.id ?? "demo"}`,
  shared: (): Votes => ({ a: 0, b: 0 }),
  on: {
    vote: (votes: Votes, option: unknown) =>
      option === "a" || option === "b" ? { ...votes, [option]: votes[option] + 1 } : votes,
  },
};

export default function LivePoll({ state }: { state: Votes }) {
  return (
    <div>
      <button data-live="vote" value="a">A</button>
      <strong>a: {state.a} / b: {state.b}</strong>
      <button data-live="vote" value="b">B</button>
    </div>
  );
}
```

- A room id is 1 to 120 characters without whitespace. The island's signed state is just its
  room, so a client can't move itself into another room.
- Rooms live in the memory of the server process. They are not shared across instances.
- `nowaki start` saves rooms to `.nowaki/live-rooms.json` (at most every 2 s, and on SIGTERM /
  SIGINT) and loads them on the next start. `NOWAKI_LIVE_ROOMS_FILE` picks another file (relative
  to the app root); `off` turns saving off. Under `nowaki dev`, rooms are lost on restart. On
  Windows there is no SIGTERM for the renderer, so only the periodic write applies.

Working examples: `examples/hello/islands/LivePoll.tsx`, `examples/hello/routes/poll.tsx`.

## Presence

An element with `data-nowaki-presence` shows a live count: `data-nowaki-presence=""` the
connections to the server process, `data-nowaki-presence="poll:demo"` the members of that room.
Each update is also dispatched on `window` as `nowaki:presence` (`detail: { count, room }`).

```tsx
<p>people here: <strong data-nowaki-presence="poll:demo">0</strong></p>
```

Presence needs the WebSocket transport (`nowaki dev` / `nowaki start`).

## Client events

| Event (on `window`) | When |
| --- | --- |
| `nowaki:live-error` | an event was not applied (`detail: { nid, reason }`: `"forbidden"`, `"render failed"`, a timeout, a full queue); the island keeps its last HTML |
| `nowaki:live-stale` | the page's signed state is older than `NOWAKI_LIVE_MAX_AGE`; the runtime reloads the page unless a listener calls `preventDefault()` (to save a draft first, say) |
| `nowaki:presence` | a presence count changed |

## Where it runs

Live islands work on every server, with two transports:

| Server | Transport | `publish()`, rooms across tabs, presence |
| --- | --- | --- |
| `nowaki dev`, `nowaki start` | WebSocket (`/__nowaki/live`), POST while the socket is down | yes, within the one process |
| node, bun, deno, vercel, cloudflare adapters | one POST per event (`/__nowaki/live-event`) | no |
| static output | none | no |

On the adapters, each event is a POST that returns the new HTML to the browser that sent it.
There is no server push: `publish()` does nothing (warned once), presence shows nothing, and a
room's shared state lives in the memory of whichever instance (or Worker isolate) handled the
event; other members see a change only after their own next event, and only if the same
instance serves it. Use the adapters for live islands whose state is per visitor.

In static output (`nowaki prerender`, the static adapter), live islands stay as their first
HTML: there is no server for their events. The build lists those pages.

A page can pin the transport with `<meta name="nowaki-live" content="ws">` or `"post"` in its
`head`.

## Production settings

| Variable | Default | What it does |
| --- | --- | --- |
| `NOWAKI_LIVE_SECRET` | a random key per process | The signing key. **Set it in production.** Without it, state can't resume after a restart or on another instance, and on the node / bun / deno adapters events fail as soon as more than one instance runs. `nowaki start` and the node adapter warn at startup; the cloudflare and vercel adapters refuse live events (503) without it. |
| `NOWAKI_LIVE_MAX_AGE` | 86400 (24 h) | Seconds a signed state stays valid. An active island is re-signed on every patch. |
| `NOWAKI_LIVE_MAX` | 10000 | WebSocket connections per process; over it, a new connection is told "at capacity" and the page keeps its first HTML. |
| `NOWAKI_LIVE_RENDER_TIMEOUT_MS` | 10000 | How long one live render may take. |
| `NOWAKI_LIVE_ROOMS_FILE` | `.nowaki/live-rooms.json` | Where `nowaki start` saves rooms; `off` disables it. |

Several `nowaki start` instances behind a load balancer each have their own connections, rooms
and `publish()` reach. Pin a visitor to one instance (sticky sessions) if they must see the same
room, and share `NOWAKI_LIVE_SECRET` between instances.

## Reference

- [Runtime API](../reference/runtime.md) (`Live`, `publish`, `getContext`, `IslandModule`)
- [Client events and attributes](../reference/client-events.md) (`data-live*`,
  `data-nowaki-presence`, `nowaki:live-error`, `nowaki:live-stale`, `nowaki:presence`)
- [Environment variables](../reference/env-vars.md) (`NOWAKI_LIVE_*`)
