import { useEffect, useState } from "preact/hooks";
import { Link } from "@nowaki-dev/runtime/navigation";

// <Link viewTransition> rendered on the server and again in the browser (after hydration).
export default function VtLink() {
  const [client, setClient] = useState(false);
  useEffect(() => setClient(true), []);
  return (
    <p>
      <Link id="vt-island-ssr" viewTransition href="/about">
        about (server)
      </Link>{" "}
      {client && (
        <Link id="vt-island-client" viewTransition href="/about">
          about (client)
        </Link>
      )}
    </p>
  );
}
