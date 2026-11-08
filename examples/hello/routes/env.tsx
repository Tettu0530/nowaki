// Server variables from env.ts: validated at startup, read in the loader, never sent to the client.
import { env } from "@nowaki-dev/runtime/env/server";
import EnvBadge from "../islands/EnvBadge.tsx";

export const title = "Env — Nowaki";
export const sitemap = false;

export const loader = () => ({ tokenLength: env.HELLO_API_TOKEN.length });

export default function Env({ data }: { data: { tokenLength: number } }) {
  return (
    <main>
      <h1>Env</h1>
      <p id="token-length">token length {data.tokenLength}</p>
      <p id="public-greeting">{import.meta.env.PUBLIC_HELLO_GREETING}</p>
      <EnvBadge />
    </main>
  );
}
