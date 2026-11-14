"use server";

import { getContext, serverFn } from "@nowaki-dev/runtime";

// A hand-written Standard Schema. Zod, Valibot or ArkType schemas work the same way.
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

/**
 * An example server function: the input is validated, and getContext() gives the request (for
 * auth in a real app).
 */
export const echo = serverFn(message, async (text) => ({
  ok: true,
  echo: text,
  hasRequest: getContext() != null,
}));
