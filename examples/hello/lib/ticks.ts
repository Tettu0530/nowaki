// Server-side counter shared by routes/api/tick.ts (writes) and islands/LiveTicks.tsx (reads).
let ticks = 0;
export const readTicks = () => ticks;
export const bumpTicks = () => ++ticks;
