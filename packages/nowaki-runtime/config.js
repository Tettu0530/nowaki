// nowaki.config helpers (@nowaki-dev/runtime/config). Types live in config.d.ts; the config is
// validated by server/site-config.mjs when `nowaki dev` / `build` reads it.
//   export default defineConfig({ site: "https://example.com", basePath: "/app" });

/// Returns `config` as it is: it only gives the object the NowakiConfig type.
export function defineConfig(config) {
  return config;
}
