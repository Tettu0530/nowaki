import { useState } from "preact/hooks";

export default function Like({ slug }: { slug: string }) {
  const [n, setN] = useState(0);
  return (
    <button data-slug={slug} onClick={() => setN(n + 1)}>
      like ({n})
    </button>
  );
}
