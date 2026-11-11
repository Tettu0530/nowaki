// View Transitions: `export const viewTransition` opts every client navigation to and from this
// page in (and full loads between opted pages, through @view-transition). transitionName() gives
// the card's title the name the detail page's heading has, so one morphs into the other.
import { Link, transitionName } from "@nowaki-dev/runtime/navigation";
import VtLink from "../../islands/VtLink.tsx";

export const title = "View Transitions — Nowaki";
export const viewTransition = true;

export default function Transitions() {
  return (
    <main>
      <h1 id="vt-list">Transitions</h1>
      <Link id="vt-card" href="/vt/detail">
        <span style={transitionName("vt-hero")}>Detail</span>
      </Link>
      <VtLink />
    </main>
  );
}
