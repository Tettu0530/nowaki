import { transitionName } from "@nowaki-dev/runtime/navigation";

export const title = "Transition detail — Nowaki";
export const viewTransition = true;

export default function Detail() {
  return (
    <main>
      <h1 id="vt-detail" style={transitionName("vt-hero")}>
        Detail
      </h1>
      <a href="/vt">back to the list</a>
    </main>
  );
}
