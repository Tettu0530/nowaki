// Every variable the gallery needs, checked by `nowaki build` and again by the server at startup:
// a missing or invalid one stops it with the variable's name (never its value).
import { defineEnv } from "@nowaki-dev/runtime/env";
import { z } from "zod";

export default defineEnv({
  server: {
    // The one password that signs in (routes/login.tsx). Required: no default.
    GALLERY_ADMIN_PASSWORD: z.string().min(1),
    // Encrypts the session cookie (ctx.session). Declared here so a missing secret fails at
    // startup instead of on the first sign-in.
    NOWAKI_SESSION_SECRET: z.string().min(32),
  },
  public: {
    // Inlined into client code as import.meta.env.PUBLIC_GALLERY_TITLE.
    PUBLIC_GALLERY_TITLE: z.string().default("Sirocco"),
  },
});
