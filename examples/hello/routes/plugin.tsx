// Plugin transform hook demo. mark-replace in nowaki.config.mjs replaces "__PLUGIN_MARK__"
// in source with "transformed-by-plugin" during build/dev transforms.
export default function PluginDemo() {
  const mark = "__PLUGIN_MARK__";
  return (
    <main style="max-width:40rem;margin:3rem auto;padding:0 1.25rem;font-family:system-ui">
      <h1>Plugin transform</h1>
      <p>
        A config plugin rewrote a token in this file's source before oxc ran: <strong>{mark}</strong>
      </p>
    </main>
  );
}
