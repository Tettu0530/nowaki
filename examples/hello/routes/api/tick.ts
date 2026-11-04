// POST /api/tick: bumps the shared counter and publishes "ticks" (see islands/LiveTicks.tsx).
import { publish } from "@nowaki-dev/runtime";
import { bumpTicks } from "../../lib/ticks.ts";

type Ctx = { json: (data: unknown) => unknown };

export function POST(ctx: Ctx) {
  const ticks = bumpTicks();
  publish("ticks");
  return ctx.json({ ticks });
}
