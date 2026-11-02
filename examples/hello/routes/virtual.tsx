import VirtualBadge from "../islands/VirtualBadge.tsx";

export const title = "Virtual modules — Nowaki";

export default function Page() {
  return (
    <main style="font-family:sans-serif;max-width:640px;margin:4rem auto">
      <h1>Virtual modules</h1>
      <p>
        The plugin's <code>resolveId</code> / <code>load</code> generate a module that isn't on disk
        (<code>virtual:build-info</code>), and an island imports it.
      </p>
      <VirtualBadge />
      <p style="margin-top:2rem">
        <a href="/">← home</a>
      </p>
    </main>
  );
}
