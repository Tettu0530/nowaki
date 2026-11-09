// Sessions: `ctx.session` in loaders, actions, middleware, API routes, and `getContext().session` in
// server functions. Options go in the app root's session.ts:
//   export default defineSession({ cookieName, maxAge, rolling, store });
export { defineSession } from "./server/session.mjs";
