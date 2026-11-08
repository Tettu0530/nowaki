// Public env values (env.ts `public`) are inlined into client code at build time.
export default function EnvBadge() {
  return (
    <span id="env-badge">
      {import.meta.env.PUBLIC_HELLO_GREETING} x{import.meta.env.PUBLIC_HELLO_ITEMS + 1}
    </span>
  );
}
