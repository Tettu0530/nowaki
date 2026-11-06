// Redirects to /about on the same server under the other loopback name (127.0.0.1 <-> localhost),
// which is another origin: the client router's cross-origin redirect test.
type Ctx = { get: (name: string) => string | undefined; redirect: (to: string) => unknown };

export default function handler(ctx: Ctx) {
  const [name, port] = (ctx.get("x-forwarded-host") ?? ctx.get("host") ?? "").split(":");
  const other = name === "localhost" ? "127.0.0.1" : "localhost";
  return ctx.redirect(`http://${other}${port ? `:${port}` : ""}/about`);
}
