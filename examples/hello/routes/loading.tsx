// loading boundary. If a client navigation takes over 150ms, this UI shows until the target arrives.
// A server component with zero islands. To nest, add routes/<dir>/loading.tsx.
// Its inline <style> carries nonce(), so it applies under NOWAKI_CSP=enforce too.
import { nonce } from "@nowaki-dev/runtime";

export default function Loading() {
  return (
    <main style="font-family:system-ui,sans-serif;max-width:640px;margin:4rem auto;padding:0 1.25rem">
      <div
        data-testid="loading"
        style="height:1.6rem;width:42%;border-radius:8px;background:linear-gradient(90deg,#eef1f4,#e2e6eb,#eef1f4);background-size:200% 100%;animation:nwk-pulse 1.1s ease-in-out infinite"
      />
      <p style="color:#56616f;margin:1rem 0 0">Loading…</p>
      <style nonce={nonce()}>{`@keyframes nwk-pulse{0%{background-position:200% 0}100%{background-position:-200% 0}}`}</style>
    </main>
  );
}
