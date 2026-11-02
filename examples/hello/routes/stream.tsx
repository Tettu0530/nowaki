// Streaming SSR demo. `streaming = true` sends the shell immediately and streams the body.
import Counter from "../islands/Counter.tsx";

export const streaming = true;

export const loader = async () => {
  // Simulates a real app's slow data fetch. The shell arrives first without waiting.
  await new Promise((r) => setTimeout(r, 40));
  return { mode: "streamed" };
};

export default function Stream({ data }: { data: { mode: string } }) {
  return (
    <main style="max-width:40rem;margin:3rem auto;padding:0 1.25rem;font-family:system-ui">
      <h1>Streaming SSR</h1>
      <p>
        This page used <code>export const streaming = true</code>. The shell is flushed before the
        loader resolves; loader said: <strong>{data.mode}</strong>.
      </p>
      <Counter start={5} />
    </main>
  );
}
