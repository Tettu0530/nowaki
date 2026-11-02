// Island for client:only. Not SSR'd; rendered on the client only (reads window directly).
import { useState, useEffect } from "preact/hooks";

export default function ClientOnly() {
  const [w, setW] = useState(0);
  useEffect(() => {
    setW(window.innerWidth);
  }, []);
  return (
    <p data-testid="client-only" style="font:14px ui-monospace,monospace">
      window.innerWidth = {w}
    </p>
  );
}
