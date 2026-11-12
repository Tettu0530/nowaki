// A client island with local state: the HMR demo. Edit the markup below while `nowaki dev` runs
// and the count stays (Preact Fast Refresh); add or remove a hook and it starts over.
import { useState } from "preact/hooks";

export default function Likes({ label }: { label: string }) {
  const [n, setN] = useState(0);
  return (
    <button type="button" id="likes" class="likes" onClick={() => setN(n + 1)}>
      {label} {n}
    </button>
  );
}
