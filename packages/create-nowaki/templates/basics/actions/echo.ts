"use server";

import { getContext, serverFn } from "@nowaki-dev/runtime";

// Hand-written Standard Schema (no zod/valibot) — same pattern as examples/hello/actions/todos.ts.
const message = {
  "~standard": {
    version: 1 as const,
    vendor: "example",
    validate: (v: unknown) =>
      typeof v === "string" && v.length <= 120
        ? { value: v.trim() }
        : { issues: [{ message: "message must be a string of at most 120 characters" }] },
  },
};

/** Example server function — validated input and getContext() for auth in real apps. */
export const echo = serverFn(message, async (text) => ({
  ok: true,
  echo: text,
  hasRequest: getContext() != null,
}));
