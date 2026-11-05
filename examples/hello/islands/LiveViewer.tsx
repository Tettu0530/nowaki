// Live query that reads the request: every viewer of the same tick sees their own name. Because
// the render calls getContext(), the server renders it per connection; renders that don't read
// the request are shared by every connection with the same state (one render per publish).
import { getContext } from "@nowaki-dev/runtime";
import { readTicks } from "../lib/ticks.ts";

export const live = {
  state: () => ({ ticks: readTicks() }),
  subscribe: ["ticks"],
  load: (s) => ({ ...s, ticks: readTicks() }),
  on: {},
};

export default function LiveViewer({ state }) {
  const who = getContext()?.cookies?.user ?? "guest";
  return (
    <p>
      tick {state.ticks} for <strong data-testid="viewer">{who}</strong>
    </p>
  );
}
