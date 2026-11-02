// Type-safe navigation demo. Link is a typed <a>; route() builds hrefs for dynamic routes.
// Route types come from .nowaki/types.d.ts via `nowaki typegen` (generated automatically by dev/build).
import { route, Link } from "@nowaki-dev/runtime/navigation";
import Photo from "../islands/Photo.tsx";

export const title = "Typed nav — Nowaki";

export default function Nav() {
  return (
    <main style="font-family:system-ui,sans-serif;max-width:640px;margin:4rem auto;padding:0 1.25rem">
      <h1>Typed navigation</h1>
      <Photo />

      <ul>
        <li>
          <Link href="/about" data-testid="link-about">
            About (static, type-checked)
          </Link>
        </li>
        <li>
          <a href={route("/blog/[slug]", { slug: "hello" })} data-testid="link-blog">
            First post (built with route)
          </a>
        </li>
        <li>
          <a href={route("/files/[...path]", { path: ["docs", "intro"] })} data-testid="link-files">
            Files (catch-all)
          </a>
        </li>
      </ul>
    </main>
  );
}
