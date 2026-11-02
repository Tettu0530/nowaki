"use server";

// "use server" module. Its exports become RPC endpoints that stay on the server.
// The client only gets a tiny fetch proxy (SERVER_SECRET and store are not in the bundle).

import { getContext } from "@nowaki-dev/runtime";

const SERVER_SECRET = "nowaki-server-only-secret-42";
const store: string[] = ["learn nowaki", "ship server functions"];

export async function listTodos(): Promise<string[]> {
  return store.slice();
}

export async function addTodo(text: string): Promise<string[]> {
  const t = String(text ?? "").trim();
  if (!t) throw new Error("empty todo");
  store.push(t);
  return store.slice();
}

// Version to pass as a form action. Submitting `<form action={addTodoForm}>` turns FormData into
// { text } and updates the store on the server.
export async function addTodoForm(form: { text?: string }): Promise<string[]> {
  const t = String(form?.text ?? "").trim();
  if (t) store.push(t);
  return store.slice();
}

// getContext() is valid only during an RPC. It can read the session from cookies/headers (auth, etc.).
export async function whoami(): Promise<string> {
  const ctx = getContext();
  const user = ctx?.cookies?.user ?? "anonymous";
  return `${user} (server secret is ${SERVER_SECRET.length} chars)`;
}
