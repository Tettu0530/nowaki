// Sessions (server/session.mjs + the handler's commit path), with an in-memory env: round trip,
// tampering, expiry, key rotation, regenerate, the 4 KB limit, store mode, the cross-site and live
// read-only rules, the missing-secret and prerender errors, and a failing commit rendering the 500
// page. No server needed.
import { createRequire } from "node:module";
import { handleRequest } from "../packages/nowaki-runtime/server/handler.mjs";
import { makeContext } from "../packages/nowaki-runtime/server/context.mjs";
import { configureSessions, defineSession, openCookie, sealCookie } from "../packages/nowaki-runtime/server/session.mjs";
import { setBasePath } from "../packages/nowaki-runtime/server/base-path.mjs";

const { h } = createRequire(new URL("../packages/nowaki-runtime/server/handler.mjs", import.meta.url))("preact");

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail !== undefined) console.log(String(detail).slice(0, 2000));
  }
};
const rejects = async (fn, re) => {
  try {
    await fn();
    return false;
  } catch (e) {
    return re.test(e.message);
  }
};

const SECRET = "a".repeat(32) + "-current-session-secret";
const OLD = "b".repeat(32) + "-previous-session-secret";
let secret = SECRET;
const useSessions = (opts = {}, extra = {}) =>
  configureSessions({ config: opts && defineSession(opts), secret: () => secret, ...extra });

// --- defineSession ---
check("defineSession rejects unknown options", await rejects(() => defineSession({ cookie: "x" }), /unknown option "cookie"/));
check("defineSession rejects a bad cookie name", await rejects(() => defineSession({ cookieName: "a b" }), /cookie name token/));
check("defineSession rejects a non-integer maxAge", await rejects(() => defineSession({ maxAge: 1.5 }), /maxAge/));
check("defineSession rejects an incomplete store", await rejects(() => defineSession({ store: { get() {} } }), /store must have/));
check("defineSession defaults", JSON.stringify(defineSession()) === JSON.stringify({ cookieName: "nowaki_session", maxAge: 604800, rolling: true, store: null }));

// --- an app: routes that read and write the session ---
let lastError = null;
async function probeSession(ctx) {
  const user = (await ctx.session.get("user")) ?? null;
  let wrote = true;
  try {
    await ctx.session.set("user", "mallory");
  } catch (e) {
    wrote = e.message;
  }
  return { user, wrote, readOnly: ctx.session.readOnly };
}
const modules = {
  "routes/whoami.tsx": {
    loader: async (ctx) => ({ user: (await ctx.session.get("user")) ?? "anon", n: (await ctx.session.get("n")) ?? 0 }),
    default: ({ data }) => h("p", null, `user=${data.user} n=${data.n}`),
  },
  "routes/plain.tsx": { default: () => h("p", null, "plain") },
  "routes/login.tsx": {
    action: async (ctx) => {
      const form = await ctx.formData();
      await ctx.session.regenerate();
      await ctx.session.set("user", form.get("user"));
      return ctx.redirect("/whoami");
    },
    default: () => h("p", null, "login"),
  },
  "routes/logout.tsx": {
    action: async (ctx) => {
      await ctx.session.destroy();
      return ctx.redirect("/whoami");
    },
    default: () => h("p", null, "logout"),
  },
  "routes/count.tsx": {
    action: async (ctx) => {
      await ctx.session.set("n", ((await ctx.session.get("n")) ?? 0) + 1);
      return ctx.redirect("/whoami");
    },
    default: () => h("p", null, "count"),
  },
  "routes/big.tsx": {
    action: async (ctx) => {
      await ctx.session.set("blob", "x".repeat(5000));
      return ctx.redirect("/whoami");
    },
    default: () => h("p", null, "big"),
  },
  "routes/api/probe.ts": { POST: (ctx) => probeSession(ctx) },
  // A page without an action renders on POST: the session there is read-only on a cross-site request.
  "routes/probe.tsx": {
    loader: (ctx) => probeSession(ctx),
    default: ({ data }) => h("pre", null, JSON.stringify(data)),
  },
  "routes/api/hook.ts": {
    csrf: false,
    POST: async (ctx) => ({ user: (await ctx.session.get("user")) ?? null, readOnly: ctx.session.readOnly }),
  },
  "routes/early.tsx": {
    streaming: "early",
    loader: async (ctx) => {
      try {
        await ctx.session.set("late", 1);
        return "wrote";
      } catch (e) {
        return e.message;
      }
    },
    default: ({ data }) => h("p", { id: "early" }, data),
  },
  "routes/_500.tsx": { default: ({ error }) => h("p", { id: "e500" }, `500: ${error.message}`) },
};
const route = (file, lit) => ({ file, segments: lit.split("/").filter(Boolean).map((l) => ({ lit: l })), dir: "/", isApi: file.includes("/api/") });
const table = {
  routes: [
    route("routes/whoami.tsx", "/whoami"),
    route("routes/plain.tsx", "/plain"),
    route("routes/login.tsx", "/login"),
    route("routes/logout.tsx", "/logout"),
    route("routes/count.tsx", "/count"),
    route("routes/big.tsx", "/big"),
    route("routes/api/probe.ts", "/api/probe"),
    route("routes/probe.tsx", "/probe"),
    route("routes/api/hook.ts", "/api/hook"),
    route("routes/early.tsx", "/early"),
  ],
  layouts: [],
  middleware: [],
  errorRoute: "routes/_500.tsx",
};
const env = {
  routeTable: async () => table,
  importModule: async (file) => modules[file],
  ensureIslands: async () => {},
  renderDocument: ({ body }) => body,
  renderShell: () => ({ head: "<head>", tail: "</tail>" }),
  renderError: (err) => ({ status: 500, headers: {}, body: `builtin: ${err.message}` }),
  onError: (err) => {
    lastError = err;
  },
};
const ORIGIN = "http://app.test";
const req = (path, { method = "GET", cookie, body, origin, proto = "http" } = {}) =>
  handleRequest(env, {
    method,
    url: new URL(`${proto}://app.test${path}`),
    headers: {
      host: "app.test",
      ...(cookie ? { cookie } : {}),
      ...(origin ? { origin } : {}),
      ...(body !== undefined ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    readBody: async () => new TextEncoder().encode(body ?? ""),
    version: 1,
  });
const text = async (res) => res.body ?? (await new Response(res.stream).text());
const setCookies = (res) => [res.headers["set-cookie"] ?? []].flat();
const sessionCookie = (res, name = "nowaki_session") => {
  const c = setCookies(res).find((s) => s.startsWith(`${name}=`));
  return c ? c.slice(name.length + 1, c.indexOf(";")) : undefined;
};
const post = (path, opts = {}) => req(path, { method: "POST", origin: ORIGIN, body: "", ...opts });

// --- cookie store ---
useSessions();
{
  const plain = await req("/plain");
  check("a request that never touches the session sets no cookie", setCookies(plain).length === 0);
  const anon = await req("/whoami");
  check("no cookie → empty session, and reading it writes nothing", (await text(anon)).includes("user=anon") && setCookies(anon).length === 0);

  const login = await post("/login", { body: "user=alice" });
  const c1 = sessionCookie(login);
  const attrs = setCookies(login)[0] ?? "";
  check("a write sets the session cookie on the redirect", login.status === 302 && /^v1\.[A-Za-z0-9_-]+$/.test(c1 ?? ""), attrs);
  check("cookie is HttpOnly; SameSite=Lax; Path=/; Max-Age=maxAge, not Secure over http",
    /HttpOnly/.test(attrs) && /SameSite=Lax/.test(attrs) && /Path=\//.test(attrs) && /Max-Age=604800/.test(attrs) && !/Secure/.test(attrs), attrs);
  check("the response that sets the cookie is private", !/public/.test(String(login.headers["cache-control"] ?? "")));
  const me = await req("/whoami", { cookie: `nowaki_session=${c1}` });
  check("round trip: the next request reads the value", (await text(me)).includes("user=alice"));
  check("a read inside the first half of the lifetime reissues nothing", setCookies(me).length === 0);

  const count = await post("/count", { cookie: `nowaki_session=${c1}` });
  const c2 = sessionCookie(count);
  check("each write is a fresh ciphertext", c2 && c2 !== c1);
  check("values written across requests accumulate", (await text(await req("/whoami", { cookie: `nowaki_session=${c2}` }))).includes("user=alice n=1"));

  const secure = await post("/login", { body: "user=alice", proto: "https", origin: "https://app.test" });
  check("Secure over https", /; Secure/.test(setCookies(secure)[0] ?? ""));

  // Tampering: any changed byte fails the GCM tag; the session reads as empty.
  const bytes = c1.split("");
  const i = 20;
  bytes[i] = bytes[i] === "A" ? "B" : "A";
  check("a tampered cookie reads as an empty session", (await text(await req("/whoami", { cookie: `nowaki_session=${bytes.join("")}` }))).includes("user=anon"));
  check("a truncated cookie reads as empty", (await text(await req("/whoami", { cookie: `nowaki_session=${c1.slice(0, 30)}` }))).includes("user=anon"));
  check("garbage reads as empty", (await text(await req("/whoami", { cookie: "nowaki_session=v1.%%%" }))).includes("user=anon"));
  const forged = await sealCookie("z".repeat(40), "nowaki_session", { d: { user: "admin" }, iat: 1, exp: 9e9 });
  check("a cookie sealed with another secret reads as empty", (await text(await req("/whoami", { cookie: `nowaki_session=${forged}` }))).includes("user=anon"));
  // The cookie name is the additional data: a cookie can't be replayed under another name.
  const other = await sealCookie(SECRET, "other_cookie", { d: { user: "admin" }, iat: 1, exp: 9e9 });
  check("a cookie sealed for another cookie name reads as empty", (await text(await req("/whoami", { cookie: `nowaki_session=${other}` }))).includes("user=anon"));

  // Expiry is inside the ciphertext, so a client can't extend it.
  const t = Math.floor(Date.now() / 1000);
  const expired = await sealCookie(SECRET, "nowaki_session", { d: { user: "alice" }, iat: t - 100, exp: t - 1 });
  check("an expired session reads as empty", (await text(await req("/whoami", { cookie: `nowaki_session=${expired}` }))).includes("user=anon"));
  const old = await sealCookie(SECRET, "nowaki_session", { d: { user: "alice" }, iat: t - 500000, exp: t + 100000 });
  const rolled = await req("/whoami", { cookie: `nowaki_session=${old}` });
  check("rolling: a read past half the lifetime reissues the cookie", (await text(rolled)).includes("user=alice") && /Max-Age=604800/.test(setCookies(rolled)[0] ?? ""));

  // Key rotation: NOWAKI_SESSION_SECRET="new,old" reads old cookies and reissues them with the new key.
  secret = OLD;
  const underOld = sessionCookie(await post("/login", { body: "user=carol" }));
  secret = `${SECRET},${OLD}`;
  const rotated = await req("/whoami", { cookie: `nowaki_session=${underOld}` });
  const reissued = sessionCookie(rotated);
  check("rotation: a cookie from the previous secret still reads", (await text(rotated)).includes("user=carol"));
  check("rotation: it is reissued under the first secret", !!reissued && !!(await openCookie(SECRET, "nowaki_session", reissued)) && !(await openCookie(OLD, "nowaki_session", reissued)));
  secret = SECRET;
  check("rotation: once the old secret is gone, its cookies read as empty", (await text(await req("/whoami", { cookie: `nowaki_session=${underOld}` }))).includes("user=anon"));

  const out = await post("/logout", { cookie: `nowaki_session=${c1}` });
  check("destroy deletes the cookie", /^nowaki_session=; Max-Age=0/.test(setCookies(out)[0] ?? ""), setCookies(out));

  const regen = await post("/login", { body: "user=alice", cookie: `nowaki_session=${c1}` });
  check("regenerate on sign-in sends a new cookie", sessionCookie(regen) && sessionCookie(regen) !== c1);

  // 4 KB: the write throws (here uncaught: the 500 page) and no oversized cookie goes out.
  lastError = null;
  const big = await post("/big", { cookie: `nowaki_session=${c1}` });
  check("a value that would pass 4 KB throws a clear error", big.status === 500 && /4096-byte cookie limit/.test(lastError?.message ?? ""), lastError?.message);
  check("…and no session cookie is sent", sessionCookie(big) === undefined);

  // CSRF: a cross-site POST to an API route is rejected; one that still renders (a page without an
  // action) carrying a valid cookie sees an empty, read-only session.
  const rejected = await post("/api/probe", { cookie: `nowaki_session=${c1}`, origin: "http://evil.test" });
  check("cross-site API POST: rejected (403), no cookie goes out", rejected.status === 403 && setCookies(rejected).length === 0, rejected.status);
  const probe = await post("/probe", { cookie: `nowaki_session=${c1}`, origin: "http://evil.test" });
  const pj = JSON.parse((await text(probe)).replace(/^<pre>|<\/pre>$/g, "").replace(/&quot;/g, '"'));
  check("cross-site POST: the session reads as empty", pj.user === null, JSON.stringify(pj));
  check("cross-site POST: writes throw (read-only)", pj.readOnly === true && /read-only on a cross-site request/.test(String(pj.wrote)), JSON.stringify(pj));
  check("cross-site POST: no cookie goes out", setCookies(probe).length === 0);
  const same = JSON.parse(await text(await post("/api/probe", { cookie: `nowaki_session=${c1}` })));
  check("same-site POST: the session reads and writes", same.user === "alice" && same.wrote === true && same.readOnly === false, JSON.stringify(same));
  const hook = JSON.parse(await text(await post("/api/hook", { cookie: `nowaki_session=${c1}`, origin: "http://evil.test" })));
  check("csrf = false: a cross-site POST sees the session", hook.user === "alice" && hook.readOnly === false, JSON.stringify(hook));

  // Early streaming: the headers are out before the loader runs, so a write there throws.
  const early = await text(await req("/early", { cookie: `nowaki_session=${c1}` }));
  check('streaming = "early": a write after the shell throws', /changed after the response headers were built/.test(early), early);

  // Live renders: read-only (no response to carry a cookie).
  const lctx = makeContext({ url: new URL("http://app.test/__nowaki/live"), method: "POST", headers: { cookie: `nowaki_session=${c1}` }, sessionMode: "live" });
  check("live context: reads the session", (await lctx.session.get("user")) === "alice");
  check("live context: writes throw", await rejects(() => lctx.session.set("x", 1), /read-only in live island renders/));

  // ISR: reading the session reads the cookie header, so the render is per-user.
  const vctx = makeContext({ url: new URL("http://app.test/"), method: "GET", headers: {} });
  check("an untouched session records no cookie dependency", !vctx.__vary().headers.includes("cookie"));
  await vctx.session.get("x");
  check("reading the session records the cookie dependency", vctx.__vary().headers.includes("cookie"));
  check("non-JSON values are refused", await rejects(() => vctx.session.set("f", () => 1), /isn't JSON/));
}

// --- store mode ---
{
  const records = new Map();
  let failSet = false;
  const store = {
    get: async (id) => records.get(id),
    set: async (id, data, ttl) => {
      if (failSet) throw new Error("store down");
      records.set(id, { ...data, ttl });
    },
    delete: async (id) => void records.delete(id),
  };
  useSessions({ store, cookieName: "sid", rolling: false, maxAge: 3600 });
  const login = await post("/login", { body: "user=dave" });
  const c = sessionCookie(login, "sid");
  const [, id] = (c ?? "").split(".");
  check("store mode: the cookie is v1.<id>.<sig>", /^v1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(c ?? ""), c);
  check("store mode: the data is in the store with the TTL", records.get(id)?.d?.user === "dave" && records.get(id)?.ttl === 3600, JSON.stringify([...records]));
  check("store mode: the cookie holds no data", !String(c).includes("dave"));
  check("store mode: round trip", (await text(await req("/whoami", { cookie: `sid=${c}` }))).includes("user=dave"));
  const forgedSig = `v1.${id}.${"A".repeat(43)}`;
  check("store mode: a forged signature reads as empty", (await text(await req("/whoami", { cookie: `sid=${forgedSig}` }))).includes("user=anon"));
  const guessed = `v1.${"B".repeat(43)}.${c.split(".")[2]}`;
  check("store mode: another id with a valid signature reads as empty", (await text(await req("/whoami", { cookie: `sid=${guessed}` }))).includes("user=anon"));
  const regen = await post("/login", { body: "user=dave", cookie: `sid=${c}` });
  const newId = sessionCookie(regen, "sid")?.split(".")[1];
  check("store mode: regenerate moves to a new id and deletes the old record", newId && newId !== id && !records.has(id) && records.get(newId)?.d?.user === "dave");
  check("store mode: the old cookie is worthless after regenerate", (await text(await req("/whoami", { cookie: `sid=${c}` }))).includes("user=anon"));
  const t = Math.floor(Date.now() / 1000);
  records.set(newId, { d: { user: "dave" }, iat: t - 7200, exp: t - 3600 });
  check("store mode: an expired record reads as empty even if the store kept it", (await text(await req("/whoami", { cookie: `sid=${sessionCookie(regen, "sid")}` }))).includes("user=anon"));
  const big = await post("/big", { cookie: `sid=${sessionCookie(regen, "sid")}` });
  check("store mode: no 4 KB limit", big.status === 302);
  const fresh = sessionCookie(await post("/login", { body: "user=erin" }), "sid");
  const out = await post("/logout", { cookie: `sid=${fresh}` });
  check("store mode: destroy deletes the record and the cookie", !records.has(fresh.split(".")[1]) && /^sid=; Max-Age=0/.test(setCookies(out)[0] ?? ""));

  // A commit that fails renders the 500 page (the commit is awaited inside the error handling).
  failSet = true;
  lastError = null;
  const failed = await post("/count", { cookie: `sid=${fresh}` });
  // Production: the error reaches onError, the page gets no error text.
  const failedBody = await text(failed);
  check("a failing session commit renders the 500 page", failed.status === 500 && failedBody.includes('id="e500">500: <') && /store down/.test(lastError?.message ?? ""), failed.status);
  check("…and sends no session cookie", sessionCookie(failed, "sid") === undefined);
  failSet = false;
}

// --- where sessions can't work ---
{
  secret = undefined;
  useSessions();
  const ctx = makeContext({ url: new URL("http://app.test/"), method: "GET", headers: {} });
  check("no NOWAKI_SESSION_SECRET: first access throws a clear error", await rejects(() => ctx.session, /NOWAKI_SESSION_SECRET is not set/));
  lastError = null;
  const page = await req("/whoami");
  check("…which renders the 500 page", page.status === 500 && /NOWAKI_SESSION_SECRET/.test(lastError?.message ?? ""));
  check("…while pages that don't use sessions still work", (await req("/plain")).status === 200);
  secret = "short";
  check("a secret under 32 characters is refused", await rejects(() => makeContext({ url: new URL("http://app.test/"), headers: {} }).session, /at least 32 characters/));
  secret = SECRET;
  useSessions({}, { prerender: true });
  check("prerendering: ctx.session throws", await rejects(() => makeContext({ url: new URL("http://app.test/"), headers: {} }).session, /prerendered page/));
  useSessions();
}

// --- basePath: the cookie is scoped to it ---
useSessions();
setBasePath("/app");
{
  const login = await post("/login", { body: "user=alice" });
  const attrs = setCookies(login)[0] ?? "";
  check("under basePath the cookie has Path=/app", /; Path=\/app;/.test(attrs), attrs);
}
setBasePath("");

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("session: all checks passed");
