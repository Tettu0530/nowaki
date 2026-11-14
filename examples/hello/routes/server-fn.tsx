import { listTodos } from "../actions/todos.ts";
import ServerTodos from "../islands/ServerTodos.tsx";

export const title = "Server functions — Nowaki";

// On the server, a server function is a direct call (no HTTP): the loader awaits it.
export const loader = async () => {
  return await listTodos();
};

type Data = Awaited<ReturnType<typeof loader>>;

export default function Page({ data }: { data: Data }) {
  return (
    <main style="font-family:sans-serif;max-width:640px;margin:4rem auto">
      <h1>Server functions</h1>
      <p>
        Exports of a <code>"use server"</code> module are an RPC boundary. The implementation stays on the server,
        and the client only gets a tiny proxy that calls fetch.
      </p>
      <ServerTodos initial={data} />
      <p style="margin-top:2rem">
        <a href="/">← home</a>
      </p>
    </main>
  );
}
