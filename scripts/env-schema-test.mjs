// Typed env (env.ts): defineEnv / validateEnv / env/server units, then end to end with the nowaki
// binary on a scratch app: the build fails on a missing or invalid variable and on client code
// importing env/server, public values are inlined, the node server and the Cloudflare worker
// refuse to start or serve with a variable gone.
// Usage: node scripts/env-schema-test.mjs [path/to/nowaki]   (default target/debug/nowaki; the
// end-to-end part is skipped when the binary doesn't exist)
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { defineEnv, validateEnv, initServerEnv } from "../packages/nowaki-runtime/server/env-schema.mjs";
import { env } from "../packages/nowaki-runtime/server/env-server.mjs";

const repo = path.resolve(import.meta.dirname, "..");
const helloModules = path.join(repo, "examples/hello/node_modules");
const { z } = await import(pathToFileURL(createRequire(path.join(helloModules, "x.js")).resolve("zod")).href);

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) {
    failures++;
    if (detail !== undefined) console.log(String(detail).slice(0, 2000));
  }
};
const throws = (fn, re) => {
  try {
    fn();
    return false;
  } catch (e) {
    return re.test(e.message);
  }
};

// --- units ---
// A hand-written Standard Schema: works without any library.
const required = { "~standard": { version: 1, vendor: "test", validate: (v) => (typeof v === "string" && v ? { value: v } : { issues: [{ message: "Required" }] }) } };

check("defineEnv rejects a public name without PUBLIC_", throws(() => defineEnv({ public: { API: required } }), /must start with PUBLIC_/));
check("defineEnv rejects a server name with PUBLIC_", throws(() => defineEnv({ server: { PUBLIC_KEY: required } }), /must not start with PUBLIC_/));
check("defineEnv rejects a non-schema", throws(() => defineEnv({ server: { A: "x" } }), /not a Standard Schema/));
check("defineEnv rejects unknown keys", throws(() => defineEnv({ client: {} }), /unknown key "client"/));
check("defineEnv rejects an invalid name", throws(() => defineEnv({ server: { "A-B": required } }), /not a valid variable name/));

const def = defineEnv({
  server: { DATABASE_URL: z.url(), PORT_N: z.coerce.number().int().default(5432), TOKEN: required },
  public: { PUBLIC_API: z.string().default("/api"), PUBLIC_FLAG: z.stringbool().optional() },
});
{
  const { values, errors } = await validateEnv(def, { DATABASE_URL: "postgres://db.example/app", TOKEN: "t0ken", PUBLIC_FLAG: "true" });
  check("valid source → no errors", errors.length === 0, errors);
  check("defaults and coercion apply", values.server.PORT_N === 5432 && values.public.PUBLIC_API === "/api" && values.public.PUBLIC_FLAG === true, JSON.stringify(values));
}
{
  const { errors } = await validateEnv(def, { DATABASE_URL: "not a url with s3cr3t" });
  check("invalid value is reported by name", errors.some((e) => e.startsWith("DATABASE_URL: ")), errors);
  check("missing value says missing", errors.some((e) => e.startsWith("TOKEN: missing")), errors);
  check("errors never contain the value", !errors.join("\n").includes("s3cr3t"), errors);
}

globalThis[Symbol.for("nowaki.env")] = undefined;
check("env read before startup throws a clear error", throws(() => env.TOKEN, /read before the environment was validated/));
await initServerEnv({ default: def }, { DATABASE_URL: "https://db.example", TOKEN: "abc" });
check("env/server returns server and public values", env.TOKEN === "abc" && env.PUBLIC_API === "/api" && env.PORT_N === 5432);
check("env/server is read-only", throws(() => (env.TOKEN = "x"), /read-only/));
check("env/server enumerates its keys", Object.keys(env).sort().join(",") === "DATABASE_URL,PORT_N,PUBLIC_API,PUBLIC_FLAG,TOKEN");
let thrown = null;
await initServerEnv({ default: def }, {}).catch((e) => (thrown = e));
check("initServerEnv throws listing every problem", /DATABASE_URL: missing[\s\S]*TOKEN: missing/.test(thrown?.message ?? ""), thrown?.message);
check("initServerEnv rejects a module without defineEnv", await initServerEnv({ default: {} }, {}).then(() => false, (e) => /export default defineEnv/.test(e.message)));
await initServerEnv({ default: def }, { DATABASE_URL: "https://db.example", TOKEN: "abc", PUBLIC_API: "/runtime" }, { PUBLIC_API: "/built" });
check("built public values win over the runtime environment", env.PUBLIC_API === "/built" && env.TOKEN === "abc");
await initServerEnv(null, {});
check("no env.ts → empty env", Object.keys(env).length === 0 && env.ANY === undefined);

// --- end to end ---
const bin = path.resolve(process.argv[2] ?? path.join(repo, "target/debug", process.platform === "win32" ? "nowaki.exe" : "nowaki"));
if (!existsSync(bin)) {
  console.log(`skip end-to-end: ${bin} not found`);
} else {
  const app = path.join(repo, "target/env-schema-e2e");
  rmSync(app, { recursive: true, force: true });
  const write = (rel, text) => {
    mkdirSync(path.dirname(path.join(app, rel)), { recursive: true });
    writeFileSync(path.join(app, rel), text);
  };
  write("package.json", JSON.stringify({ name: "env-e2e", private: true, type: "module" }));
  symlinkSync(helloModules, path.join(app, "node_modules"), "junction");
  write(
    "env.ts",
    `import { defineEnv } from "@nowaki-dev/runtime/env";
import { z } from "zod";
export default defineEnv({
  server: { ENV_E2E_DATABASE_URL: z.url() },
  public: { PUBLIC_ENV_E2E_NAME: z.string().min(1), PUBLIC_ENV_E2E_LIMIT: z.coerce.number().default(7) },
});
`,
  );
  write(
    "routes/index.tsx",
    `import { env } from "@nowaki-dev/runtime/env/server";
import Hello from "../islands/Hello.tsx";
export const loader = () => ({ host: new URL(env.ENV_E2E_DATABASE_URL).host });
export default function Index({ data }: { data: { host: string } }) {
  return <main><p id="host">db {data.host}</p><Hello /></main>;
}
`,
  );
  write(
    "islands/Hello.tsx",
    `export default function Hello() {
  return <b id="hello">{import.meta.env.PUBLIC_ENV_E2E_NAME}:{import.meta.env.PUBLIC_ENV_E2E_LIMIT}</b>;
}
`,
  );

  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.includes("ENV_E2E")));
  const good = { ENV_E2E_DATABASE_URL: "postgres://user:pw-e2e-secret@db.internal:5432/app", PUBLIC_ENV_E2E_NAME: "envtest" };
  const build = (vars, ...args) => spawnSync(bin, ["build", app, ...args], { env: { ...baseEnv, ...vars }, encoding: "utf8", timeout: 300_000 });
  const out = (r) => `${r.stdout}\n${r.stderr}`;

  let r = build({});
  check("build fails on missing variables", r.status !== 0 && /ENV_E2E_DATABASE_URL: missing/.test(out(r)) && /PUBLIC_ENV_E2E_NAME: missing/.test(out(r)), out(r));
  r = build({ ...good, ENV_E2E_DATABASE_URL: "nope-not-a-url-e2e" });
  check("build fails on an invalid variable, without printing it", r.status !== 0 && /ENV_E2E_DATABASE_URL: /.test(out(r)) && !out(r).includes("nope-not-a-url-e2e"), out(r));

  write("lib/config.ts", `import { env } from "@nowaki-dev/runtime/env/server";\nexport const dbUrl = () => env.ENV_E2E_DATABASE_URL;\n`);
  write("islands/Leak.tsx", `import { dbUrl } from "../lib/config.ts";\nexport default function Leak() { return <i>{dbUrl()}</i>; }\n`);
  write("routes/leak.tsx", `import Leak from "../islands/Leak.tsx";\nexport default function P() { return <Leak />; }\n`);
  r = build(good);
  check(
    "client import of env/server fails the build, naming the chain",
    r.status !== 0 && out(r).includes("islands/Leak.tsx → lib/config.ts → @nowaki-dev/runtime/env/server"),
    out(r),
  );
  for (const f of ["lib/config.ts", "islands/Leak.tsx", "routes/leak.tsx"]) rmSync(path.join(app, f));

  r = build(good, "--adapter", "node");
  check("build passes with valid variables", r.status === 0, out(r));
  check("dist/server/env.js is compiled", existsSync(path.join(app, "dist/server/env.js")));
  const clientJs = readdirSync(path.join(app, "dist/client"))
    .filter((f) => f.endsWith(".js"))
    .map((f) => readFileSync(path.join(app, "dist/client", f), "utf8"))
    .join("\n");
  check("public values are inlined into client code", /[`"']envtest[`"']/.test(clientJs) && /\b7\b/.test(clientJs));
  check("server values never reach client code", !clientJs.includes("pw-e2e-secret") && !clientJs.includes("ENV_E2E_DATABASE_URL"));

  const types = readFileSync(path.join(app, ".nowaki/types.d.ts"), "utf8");
  check("typegen declares ServerEnv and ImportMetaEnv", types.includes("interface ServerEnv extends ServerEnvOf") && types.includes("interface ImportMetaEnv extends PublicEnvOf"));

  // The node server: starts with the variable, refuses to start without it.
  const serve = (vars, port) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(app, "dist/server/index.mjs")], { env: { ...baseEnv, ...vars, PORT: String(port) } });
      let text = "";
      const done = (v) => {
        clearTimeout(timer);
        child.kill();
        resolve(v);
      };
      const timer = setTimeout(() => done({ ready: false, text, timeout: true }), 30_000);
      child.stdout.on("data", (d) => {
        text += d;
        if (text.includes("NOWAKI_START_READY")) {
          fetch(`http://127.0.0.1:${port}/`)
            .then((res) => res.text())
            .then((html) => done({ ready: true, html, text }), (e) => done({ ready: true, html: String(e), text }));
        }
      });
      child.stderr.on("data", (d) => (text += d));
      child.on("exit", (code) => done({ ready: false, code, text }));
    });
  let s = await serve({ ENV_E2E_DATABASE_URL: good.ENV_E2E_DATABASE_URL }, 4742);
  check("node server starts and reads env/server", s.ready && /db db\.internal:5432/.test(s.html ?? ""), s.text + (s.html ?? ""));
  check("server-side import.meta.env uses the validated value", /envtest:7/.test(s.html ?? ""), s.html);
  s = await serve({}, 4743);
  check("node server exits non-zero when a variable is removed after the build", !s.ready && s.code !== 0 && /ENV_E2E_DATABASE_URL: missing/.test(s.text), s.text);

  // nowaki start: the prod-sidecar's createApp throws before READY.
  r = build(good);
  check("build (default adapter) passes", r.status === 0, out(r));
  r = spawnSync(bin, ["start", app, "--port", "4744"], { env: baseEnv, encoding: "utf8", timeout: 60_000 });
  check("nowaki start exits non-zero without the variable", r.status !== 0 && r.status !== null && /ENV_E2E_DATABASE_URL: missing/.test(out(r)), `${r.status} ${out(r)}`);

  // Cloudflare worker: validated before the first request, from process.env plus the bindings.
  r = build(good, "--adapter", "cloudflare");
  check("cloudflare build passes", r.status === 0, out(r));
  const worker = path.join(app, "dist/worker/index.js");
  check("worker imports env.js", readFileSync(worker, "utf8").includes('import * as envModule from "../server/env.js"'));
  const w1 = (await import(`${pathToFileURL(worker).href}?a`)).default;
  const bad = await w1.fetch(new Request("https://app.example/"), {});
  check("worker answers 500 without the variable", bad.status === 500 && (await bad.text()) === "Internal Server Error");
  const w2 = (await import(`${pathToFileURL(worker).href}?b`)).default;
  const ok = await w2.fetch(new Request("https://app.example/"), { ENV_E2E_DATABASE_URL: good.ENV_E2E_DATABASE_URL });
  check("worker validates Worker bindings and serves", ok.status === 200 && /db db\.internal:5432/.test(await ok.text()));

  if (!process.env.KEEP) rmSync(app, { recursive: true, force: true });
}

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("env schema: all checks passed");
