# Plugins

A plugin in nowaki.config's `plugins` can rewrite source files and serve virtual modules at
build and dev time. Hooks follow Rollup's names (`transform`, `resolveId`, `load`) and run in a
Node process that `nowaki dev` and `nowaki build` start. Plugins don't run on the production
request path. `@nowaki-dev/markdoc` is a plugin (see [Content](./content.md#markdoc)).

```js
// nowaki.config.mjs
import { defineConfig } from "@nowaki-dev/runtime/config";

export default defineConfig({
  plugins: [
    {
      name: "mark-replace",
      transform(code, id) {
        if (!code.includes("__BUILD_MARK__")) return null; // not mine
        return code.replaceAll("__BUILD_MARK__", "built");
      },
    },
    {
      // `import { builtBy } from "virtual:build-info"`, a module that isn't on disk
      name: "virtual-build-info",
      resolveId(source) {
        return source === "virtual:build-info" ? source : null;
      },
      load(id) {
        if (id !== "virtual:build-info") return null;
        return `export const builtBy = "nowaki-plugin";\n`;
      },
    },
  ],
});
```

| Hook | Called | Returns |
| --- | --- | --- |
| `transform(code, id)` | on each source module before the transform (`id` is the absolute path); plugins run in order, each on the previous output | the new code (a string or `{ code }`), or `null` / `undefined` to leave it |
| `resolveId(source, importer)` | for a specifier normal resolution can't resolve | an id (a string or `{ id }`); the first plugin to return one wins |
| `load(id)` | for an id from `resolveId` | the module's source; the first plugin to return one wins |

- Hooks may be async. A falsy entry in `plugins` is skipped, so `cond && plugin()` works.
- `name` is shown in errors. A hook that throws fails the build, and shows as an error in dev.
- Plugin `console.log` output goes to stderr.
- Transformed output is cached per file content and nowaki.config. A plugin whose output depends
  on other files or on the environment should reflect that in the config, or its cached output
  can go stale.
- Plugins run with your project's privileges: treat them like any build dependency.

Type a plugin with `NowakiPlugin` from `@nowaki-dev/runtime/config`.

Working example: `examples/hello/nowaki.config.mjs` (`routes/plugin.tsx`, `routes/virtual.tsx`).

## Reference

- [Config](../reference/config.md) (`plugins`, `NowakiPlugin`)
