"use server";

// A "use server" module: its exports are RPC endpoints whose code stays on the server. Client code
// that imports them gets a small fetch proxy (SERVER_SECRET and store are not in the bundle).

import { getContext, serverFn } from "@nowaki-dev/runtime";

const SERVER_SECRET = "nowaki-server-only-secret-42";
const store: string[] = ["learn nowaki", "ship server functions"];

export async function listTodos(): Promise<string[]> {
  return store.slice();
}

// Any Standard Schema library (zod, valibot, arktype) works here; this one is hand-written so the
// example has no dependency. Invalid input never reaches the implementation (400 + issues).
const todoText = {
  "~standard": {
    version: 1 as const,
    vendor: "example",
    validate: (v: unknown) =>
      typeof v === "string" && v.trim() !== "" && v.length <= 200
        ? { value: v.trim() }
        : { issues: [{ message: "text must be 1-200 characters" }] },
  },
};

export const addTodo = serverFn(todoText, async (text): Promise<string[]> => {
  store.push(text);
  return store.slice();
});

// For use as a form action: submitting `<form action={addTodoForm}>` sends the form's fields as a
// plain object ({ text }), and the function updates the store on the server.
export async function addTodoForm(form: { text?: string }): Promise<string[]> {
  const t = String(form?.text ?? "").trim();
  if (t) store.push(t);
  return store.slice();
}

// Test fixture (scripts/security-e2e.mjs): an unexpected error's message must not reach the client in production.
export async function brokenTodo(): Promise<never> {
  throw new Error("db password is hunter2");
}

// getContext() returns the calling request's context (cookies, headers, session), for auth checks.
export async function whoami(): Promise<string> {
  const ctx = getContext();
  const user = ctx?.cookies?.user ?? "anonymous";
  return `${user} (server secret is ${SERVER_SECRET.length} chars)`;
}
