// <Link prefetch> fetches /styled while it is on screen. /gallery is the same opt-in, below the
// fold: the browser test scrolls to it. The layout's links are plain <a> and must not be fetched
// until hover. Badge is here so this page loads the islands runtime; without an island there is
// no client router, and prefetch does nothing.
import { Link } from "@nowaki-dev/runtime/navigation";
import Badge from "../islands/Badge.tsx";

export const title = "Prefetch — Nowaki";

export default function PrefetchPage() {
  return (
    <main>
      <h1 id="prefetch-page">Prefetch</h1>
      <Badge />
      <p>
        <Link id="prefetch-styled" prefetch href="/styled">
          styled
        </Link>
      </p>
      <div style="height:8000px" />
      <p>
        <Link id="prefetch-below" prefetch href="/gallery">
          gallery
        </Link>
      </p>
    </main>
  );
}
