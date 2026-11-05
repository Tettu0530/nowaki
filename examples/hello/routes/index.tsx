import Counter from "../islands/Counter.tsx";
import Logo from "../islands/Logo.tsx";
import Badge from "../islands/Badge.tsx";
import Cycle from "../islands/Cycle.tsx";

export const title = "Nowaki demo";

// First-load JS for this page (gzip). `nowaki build` fails when it grows past this.
export const budget = { js: 12 };

export const loader = async () => {
  return { message: "Welcome to Nowaki 🍃", renderedAt: new Date().toISOString() };
};

type Data = Awaited<ReturnType<typeof loader>>;

export default function Home({ data }: { data: Data }) {
  return (
    <main style="font-family:sans-serif;max-width:640px;margin:4rem auto">
      <h1><Logo /> {data.message}</h1>
      <p>Rendered on the server: {data.renderedAt}</p>
      <Counter start={5} /> <Badge /> <Cycle />
      <p>The only JS this page sends to the browser is for the island (Counter).</p>
      <p>
        <a href="/about">about (no islands, zero-JS page)</a> /{" "}
        <a href="/api/hello">API route</a>
      </p>
    </main>
  );
}
