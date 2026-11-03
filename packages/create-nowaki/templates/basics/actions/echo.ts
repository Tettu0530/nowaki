"use server";

import { getContext } from "@nowaki-dev/runtime";

/** Example server function — validate input and use getContext() for auth in real apps. */
export async function echo(message: string) {
  if (typeof message !== "string" || message.length > 120) {
    throw new Error("invalid message");
  }
  const ctx = getContext();
  return { ok: true, echo: message.trim().slice(0, 120), hasRequest: ctx != null };
}
