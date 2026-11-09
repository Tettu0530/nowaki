// ctx.session: an encrypted cookie, scoped to the basePath (Path=/gallery).
import { defineSession } from "@nowaki-dev/runtime/session";

export default defineSession({
  cookieName: "gallery_session",
  maxAge: 60 * 60 * 8,
});
