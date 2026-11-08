// The app's environment variables, each with a Standard Schema (Zod here). `nowaki build` fails on
// a missing or invalid one, and so does the server at startup.
// - server: read with `import { env } from "@nowaki-dev/runtime/env/server"`; never sent to the browser.
// - public: PUBLIC_* only; the validated values are inlined as `import.meta.env.PUBLIC_*`.
import { defineEnv } from "@nowaki-dev/runtime/env";
import { z } from "zod";

export default defineEnv({
  server: {
    HELLO_API_TOKEN: z.string().min(8).default("hello-dev-token"),
  },
  public: {
    PUBLIC_HELLO_GREETING: z.string().default("Hello from env.ts"),
    PUBLIC_HELLO_ITEMS: z.coerce.number().int().default(3),
  },
});
