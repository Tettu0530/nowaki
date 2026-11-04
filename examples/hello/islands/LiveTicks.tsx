// Live query: the island subscribes to "ticks"; whenever server code calls publish("ticks"),
// live.load runs for every subscribed island and the server pushes the new HTML.
import { readTicks } from "../lib/ticks.ts";

export const live = {
  state: () => ({ ticks: readTicks() }),
  subscribe: ["ticks"],
  load: (s) => ({ ...s, ticks: readTicks() }),
  on: {},
};

export default function LiveTicks({ state }) {
  return <p>ticks: {state.ticks}</p>;
}
