// How each framework is started and built. Every command is the framework's own CLI from the
// app's node_modules/.bin, run in the app directory.
//
//   dev          dev server; `ready` lists the substrings of its ready line
//   staticBuild  build that writes every page as HTML into `staticOut` (what a static host serves)
//   serverBuild  build for a Node server that renders pages per request (no prerendering)
//   caches       everything a cold run deletes first (build output and framework caches)
//   generated    paths gen.mjs owns; deleted and rewritten on every generate
//   idleJs       JS the framework loads only once the page is idle (counted in first-load JS,
//                and also reported on its own)

export const FRAMEWORKS = {
  nowaki: {
    label: "Nowaki",
    bin: "nowaki",
    versionPkg: "nowaki",
    dev: (port) => ["dev", ".", "--port", String(port)],
    ready: ["ready in"],
    idleJs: /\/_nowaki\/router(-core)?\.[0-9a-f]+\.js$/,
    // `nowaki build` alone does not write HTML; prerender is build + render every route.
    staticBuild: ["prerender", ".", "--out", "static-out"],
    staticOut: "static-out",
    serverBuild: ["build", "."],
    caches: ["dist", "static-out", ".nowaki", "node_modules/.cache"],
    generated: ["lib", "routes", "islands", "nowaki.config.mjs", "session.ts", "env.ts"],
  },
  astro: {
    label: "Astro",
    bin: "astro",
    versionPkg: "astro",
    env: { ASTRO_TELEMETRY_DISABLED: "1" },
    dev: (port) => ["dev", "--port", String(port)],
    ready: ["ready in", "dev server running at"],
    after: ["dev", "stop"],
    staticBuild: ["build"],
    staticOut: "dist",
    serverBuild: ["build"],
    caches: ["dist", ".astro", "node_modules/.vite", "node_modules/.astro"],
    generated: ["astro.config.mjs", "tsconfig.json", "src"],
  },
  sveltekit: {
    label: "SvelteKit",
    bin: "vite",
    versionPkg: "@sveltejs/kit",
    dev: (port) => ["dev", "--port", String(port), "--strictPort"],
    ready: ["ready in"],
    staticBuild: ["build"],
    staticOut: "build",
    serverBuild: ["build"],
    caches: [".svelte-kit", "build", "node_modules/.vite"],
    generated: ["vite.config.js", "src"],
  },
  next: {
    label: "Next.js",
    bin: "next",
    versionPkg: "next",
    env: { NEXT_TELEMETRY_DISABLED: "1" },
    dev: (port) => ["dev", "-p", String(port)],
    ready: ["ready in"],
    staticBuild: ["build"], // with output: "export"
    staticOut: "out",
    serverBuild: ["build"],
    caches: [".next", "out"],
    generated: ["next.config.mjs", "next-env.d.ts", "tsconfig.json", "lib", "app", "components"],
  },
  nuxt: {
    label: "Nuxt",
    bin: "nuxt",
    versionPkg: "nuxt",
    env: { NUXT_TELEMETRY_DISABLED: "1" },
    dev: (port) => ["dev", "--port", String(port)],
    ready: ["ready in"], // printed once the server stops answering 503
    staticBuild: ["generate"],
    staticOut: ".output/public",
    serverBuild: ["build"],
    caches: [".nuxt", ".output", "node_modules/.cache", "node_modules/.vite"],
    generated: ["nuxt.config.ts", "tsconfig.json", "server", "app"],
  },
};

export const ORDER = ["nowaki", "astro", "sveltekit", "next", "nuxt"];
