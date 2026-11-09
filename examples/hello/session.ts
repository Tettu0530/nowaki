// Session options (ctx.session). Without this file the defaults apply; the cookie is encrypted with
// keys derived from NOWAKI_SESSION_SECRET (dev generates one into .nowaki/session-secret).
import { defineSession } from "@nowaki-dev/runtime/session";

export default defineSession({
  cookieName: "hello_session",
  maxAge: 60 * 60 * 24,
});
