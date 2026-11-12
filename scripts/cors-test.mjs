// nowaki.config `cors` normalization and runtime headers. No server needed.
import { setBasePath } from "../packages/nowaki-runtime/server/base-path.mjs";
import { corsPreflight, corsResponseHeaders, isFrameworkCorsPath, originAllowed, withCorsOnResult } from "../packages/nowaki-runtime/server/cors.mjs";
import { handleRequest } from "../packages/nowaki-runtime/server/handler.mjs";
import { normalizeCors } from "../packages/nowaki-runtime/server/site-config.mjs";

const CORS = normalizeCors({
  origins: ["https://example.com"],
  methods: ["GET", "POST", "PUT"],
  headers: ["Content-Type", "Authorization"],
  credentials: true,
  maxAge: 3600,
});

let fails = 0;
const check = (name, ok) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) fails++;
};
const rejects = async (fn, re) => {
  try {
    await fn();
    return false;
  } catch (e) {
    return re.test(e.message);
  }
};

check("normalizeCors accepts the example config", CORS.origins[0] === "https://example.com" && CORS.maxAge === 3600);
check("normalizeCors adds OPTIONS to methods", CORS.methods.includes("OPTIONS"));
check(
  "credentials + wildcard origins rejected",
  await rejects(() => normalizeCors({ origins: ["*"], credentials: true }), /credentials/),
);
check(
  "wildcard cannot mix with explicit origins",
  await rejects(() => normalizeCors({ origins: ["*", "https://example.com"] }), /combine/),
);
{
  const h = corsResponseHeaders(CORS, "https://example.com", { "Access-Control-Allow-Origin": "https://example.com" });
  check(
    "does not duplicate ACAO when the handler set it",
    h["Access-Control-Allow-Origin"] === "https://example.com" && h["access-control-allow-origin"] === undefined,
  );
}
check(
  "origins must be full origins",
  await rejects(() => normalizeCors({ origins: ["/bad"] }), /full origin/),
);
check(
  "origins must be http(s)",
  await rejects(() => normalizeCors({ origins: ["file://example.com"] }), /http or https/),
);
check(
  "maxAge capped",
  await rejects(() => normalizeCors({ origins: ["https://example.com"], maxAge: 86_400 * 367 }), /maxAge/),
);
check("originAllowed matches listed origins", originAllowed(CORS, "https://example.com"));
check("originAllowed rejects other sites", !originAllowed(CORS, "https://evil.test"));
check("framework paths skip CORS", isFrameworkCorsPath("/__nowaki/fn") && isFrameworkCorsPath("/_nowaki/x.js"));
setBasePath("/app");
check(
  "basePath framework paths skip CORS",
  isFrameworkCorsPath("/app/_nowaki/x.js") && isFrameworkCorsPath("/app/__nowaki/fn") && !isFrameworkCorsPath("/app/api/x"),
);
setBasePath("");

check(
  "withCorsOnResult uses ctx.get (not ctx.headers)",
  (() => {
    let headersGetterUsed = false;
    const ctx = {
      url: new URL("https://host.example/page"),
      get(name) {
        return name === "origin" ? "https://example.com" : undefined;
      },
      get headers() {
        headersGetterUsed = true;
        return {};
      },
      __vary() {
        return { query: false, headers: ["origin"] };
      },
    };
    const out = withCorsOnResult({ cors: CORS }, ctx, { status: 200, headers: {}, body: "" });
    return out.headers["access-control-allow-origin"] === "https://example.com" && !headersGetterUsed;
  })(),
);

{
  const pre = corsPreflight(CORS, {
    method: "OPTIONS",
    origin: "https://example.com",
    pathname: "/api/hello",
    requestMethod: "POST",
    requestHeaders: "content-type, authorization",
  });
  check("preflight returns 204 with ACAO", pre?.status === 204 && pre.headers["access-control-allow-origin"] === "https://example.com");
  check("preflight exposes methods", pre?.headers["access-control-allow-methods"]?.includes("POST"));
  check("preflight sets max-age", pre?.headers["access-control-max-age"] === "3600");
  check("preflight credentials", pre?.headers["access-control-allow-credentials"] === "true");
}

check(
  "plain OPTIONS without preflight headers is not intercepted",
  corsPreflight(CORS, {
    method: "OPTIONS",
    origin: "https://example.com",
    pathname: "/api/hello",
    requestMethod: undefined,
    requestHeaders: undefined,
  }) === null,
);

check(
  "preflight skips internal paths",
  corsPreflight(CORS, {
    method: "OPTIONS",
    origin: "https://example.com",
    pathname: "/__nowaki/fn",
    requestMethod: "POST",
    requestHeaders: "content-type",
  }) === null,
);

check(
  "preflight rejects unknown request header",
  corsPreflight(CORS, {
    method: "OPTIONS",
    origin: "https://example.com",
    pathname: "/api/x",
    requestMethod: "POST",
    requestHeaders: "x-custom",
  })?.headers["access-control-allow-origin"] === undefined,
);

{
  const headers = corsResponseHeaders(CORS, "https://example.com", { "content-type": "application/json" });
  check("response adds ACAO", headers["access-control-allow-origin"] === "https://example.com");
  check("response Vary includes Origin", String(headers.vary).toLowerCase().includes("origin"));
}

{
  const table = {
    routes: [{ file: "routes/api/hello.ts", segments: [{ lit: "api" }, { lit: "hello" }], isApi: true }],
    layouts: [],
    middleware: [],
  };
  const env = {
    cors: CORS,
    routeTable: async () => table,
    importModule: async () => ({
      GET: () => ({ hello: "cors" }),
    }),
    ensureIslands: async () => {},
    renderDocument: ({ body: b }) => b,
    renderError: (err) => ({ status: 500, body: String(err) }),
    onError: () => {},
  };
  const pre = await handleRequest(env, {
    method: "OPTIONS",
    url: new URL("http://localhost/api/hello"),
    headers: {
      origin: "https://example.com",
      "access-control-request-method": "GET",
      "access-control-request-headers": "content-type",
    },
    version: 1,
  });
  check("handleRequest short-circuits OPTIONS", pre.status === 204 && pre.headers["access-control-allow-origin"] === "https://example.com");

  const get = await handleRequest(env, {
    method: "GET",
    url: new URL("http://localhost/api/hello"),
    headers: { origin: "https://example.com" },
    version: 1,
  });
  check(
    "GET API includes CORS headers",
    get.headers["access-control-allow-origin"] === "https://example.com" && get.headers["access-control-allow-credentials"] === "true",
  );
}

if (fails) process.exit(1);
console.log("all cors checks passed");
