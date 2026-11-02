// React code brought over from Next.js as-is.
// Nowaki aliases react/react-dom to preact/compat, so it runs unmodified.
import { useState } from "react";

export default function ReactCounter({ start = 0 }: { start?: number }) {
  const [count, setCount] = useState(start);
  return (
    <div style="border:1px solid #ccc;padding:1rem;border-radius:8px;display:inline-flex;align-items:center;gap:1rem">
      <button onClick={() => setCount((c) => c - 1)}>-</button>
      <strong>react: {count}</strong>
      <button onClick={() => setCount((c) => c + 1)}>+</button>
    </div>
  );
}
