// publish(topic): refresh every live island that subscribes to `topic` (`live.subscribe`), by
// running its `live.load` and pushing the patch. Under `nowaki dev` / `nowaki start` the sidecar
// tells the Rust live hub through a stdout line carrying a per-process token only Nowaki's own
// sidecars receive (NOWAKI_PUBLISH_TOKEN), so log output can't trigger it. It reaches connections
// in this process only. On the deploy adapters it does nothing (warned once).

const env = globalThis.process?.env ?? {};
let warned = false;

export function publish(topic) {
  if (typeof topic !== "string" || topic.length === 0 || topic.length > 128 || /[\s]/.test(topic)) {
    throw new TypeError("publish(topic): topic must be a non-empty string of at most 128 characters, without whitespace");
  }
  const token = env.NOWAKI_PUBLISH_TOKEN;
  if (token && globalThis.process?.stdout?.write) {
    globalThis.process.stdout.write(`NOWAKI_PUBLISH ${token} ${topic}\n`);
    return;
  }
  if (!warned) {
    warned = true;
    console.warn("[nowaki] publish() reaches live islands only under `nowaki dev` / `nowaki start`; on this server it does nothing.");
  }
}
