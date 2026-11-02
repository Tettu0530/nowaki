// Nowaki config. `plugins` can have a transform hook (transform) and virtual modules (resolveId/load).
//   transform(code, id)        — called on transformable source before oxc runs
//   resolveId(source, importer) — claims a specifier and returns an id (called only when normal resolution fails)
//   load(id)                    — returns the source for that id (a virtual module not on disk)
// Return null/undefined for no change (fast path).
export default {
  plugins: [
    {
      name: "mark-replace",
      transform(code, id) {
        if (!code.includes("__PLUGIN_MARK__")) return null;
        return code.replaceAll("__PLUGIN_MARK__", "transformed-by-plugin");
      },
    },
    {
      // Virtual module: generates and serves `virtual:build-info`, which isn't on disk.
      name: "virtual-build-info",
      resolveId(source) {
        return source === "virtual:build-info" ? source : null;
      },
      load(id) {
        if (id !== "virtual:build-info") return null;
        return `export const builtBy = "nowaki-plugin";\nexport const marker = "VIRTUAL_OK";\n`;
      },
    },
  ],
};
