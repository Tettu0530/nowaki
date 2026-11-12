// multipart/form-data parsing for LoaderContext.formData(). No server needed.
import { EventEmitter } from "node:events";
import http from "node:http";
import { readBodyWithLimit } from "../packages/nowaki-runtime/server/body-read.mjs";
import { makeContext } from "../packages/nowaki-runtime/server/context.mjs";
import { handleRequest } from "../packages/nowaki-runtime/server/handler.mjs";
import { requestBodyResult } from "../packages/nowaki-runtime/server/request-body.mjs";
import {
  FORM_BODY_LIMIT,
  boundaryFromContentType,
  isMultipartFormData,
  parseMultipartBody,
} from "../packages/nowaki-runtime/server/multipart.mjs";

function latin1Bytes(s) {
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xff;
  return u;
}

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
    return e.name === "RequestBodyError" && re.test(e.message);
  }
};

check("isMultipartFormData matches the media type only", isMultipartFormData("multipart/form-data; boundary=x"));
check(
  "substring trap: boundary=application/json is not multipart",
  !isMultipartFormData("text/plain; boundary=application/json"),
);

check(
  "boundaryFromContentType reads an unquoted boundary",
  boundaryFromContentType("multipart/form-data; boundary=abc") === "abc",
);
check(
  "boundaryFromContentType reads a quoted boundary",
  boundaryFromContentType('multipart/form-data; boundary="a\\"b"') === 'a"b',
);
check("boundaryFromContentType: missing boundary", boundaryFromContentType("multipart/form-data") === null);
check(
  "boundaryFromContentType: empty quoted boundary throws",
  await rejects(() => boundaryFromContentType('multipart/form-data; boundary=""'), /empty/),
);

function buildMultipart(boundary, parts) {
  const lines = [];
  for (const p of parts) {
    lines.push(`--${boundary}\r\n`);
    let disp = `Content-Disposition: form-data; name="${p.name}"`;
    if (p.filename) disp += `; filename="${p.filename}"`;
    if (p.filenameStar) disp += `; filename*=${p.filenameStar}`;
    lines.push(`${disp}\r\n`);
    if (p.type) lines.push(`Content-Type: ${p.type}\r\n`);
    lines.push("\r\n");
    lines.push(p.body);
    lines.push("\r\n");
  }
  lines.push(`--${boundary}--\r\n`);
  return lines.join("");
}

{
  const boundary = "bbb";
  const body = buildMultipart(boundary, [
    { name: "title", body: "hello" },
    { name: "tags", body: "a" },
    { name: "tags", body: "b" },
    { name: "pic", filename: "x.png", type: "image/png", body: "\x89PNG" },
  ]);
  const ct = `multipart/form-data; boundary=${boundary}`;
  const form = await parseMultipartBody(latin1Bytes(body), ct);
  check("text field", form.get("title") === "hello");
  check("duplicate names (getAll)", form.getAll("tags").join(",") === "a,b");
  const file = form.get("pic");
  check("file is a File", file instanceof File);
  check("file name", file?.name === "x.png");
  check("file type", file?.type === "image/png");
  check("file bytes", file && (await file.arrayBuffer()).byteLength === 4);
}

check(
  "invalid body: wrong boundary in payload",
  await rejects(
    () => parseMultipartBody(latin1Bytes("not multipart"), "multipart/form-data; boundary=x"),
    /malformed|boundary|form/i,
  ),
);
check(
  "missing boundary parameter",
  await rejects(() => parseMultipartBody(latin1Bytes("--x\r\n\r\n"), "multipart/form-data"), /requires a boundary/),
);
check(
  "parse bodyLimit option",
  await rejects(
    () =>
      parseMultipartBody(
        latin1Bytes(buildMultipart("z", [{ name: "f", filename: "big.bin", body: "0123456789" }])),
        "multipart/form-data; boundary=z",
        { bodyLimit: 5 },
      ),
    /exceeds 5 byte/,
  ),
);

check(
  "empty multipart body (no parts)",
  await rejects(
    () =>
      parseMultipartBody(
        latin1Bytes("--bbb\r\n--bbb--\r\n"),
        "multipart/form-data; boundary=bbb",
      ),
    /malformed|FormData/i,
  ),
);

check(
  "wrong boundary in header vs body",
  await rejects(
    () => parseMultipartBody(latin1Bytes("--aaa\r\n--aaa--\r\n"), "multipart/form-data; boundary=bbb"),
    /malformed|boundary|form/i,
  ),
);
check(
  "boundary over 70 characters",
  await rejects(
    () => boundaryFromContentType(`multipart/form-data; boundary=${"a".repeat(71)}`),
    /1-70/,
  ),
);

{
  let read = 0;
  check(
    "content-length over limit throws",
    await rejects(async () => {
      const ctx = makeContext({
        url: new URL("http://127.0.0.1/upload"),
        method: "POST",
        headers: {
          "content-type": "multipart/form-data; boundary=x",
          "content-length": String(FORM_BODY_LIMIT + 1),
        },
        readBody: async () => {
          read++;
          return new Uint8Array(0);
        },
      });
      await ctx.formData();
    }, /exceeds.*byte limit/),
  );
  check("content-length over limit does not read the body", read === 0);
}

{
  let resumed = false;
  const req = new EventEmitter();
  req.resume = () => {
    resumed = true;
  };
  req.headers = { "content-type": "multipart/form-data; boundary=x", "content-length": String(FORM_BODY_LIMIT + 1) };
  const ctx = makeContext({
    url: new URL("http://127.0.0.1/upload"),
    method: "POST",
    headers: req.headers,
    req,
  });
  check(
    "content-length over limit drains the unread body",
    await rejects(() => ctx.formData(), /exceeds.*byte limit/) && resumed,
  );
}

{
  const ctx = makeContext({
    url: new URL("http://127.0.0.1/upload"),
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    readBody: async () => new TextEncoder().encode("user=alice&n=1&q=a+b"),
  });
  const form = await ctx.formData();
  check("urlencoded returns FormData", form instanceof FormData && !(form instanceof URLSearchParams));
  check("urlencoded get", form.get("user") === "alice" && form.get("n") === "1" && form.get("q") === "a b");
}

{
  const boundary = "ctx";
  const body = buildMultipart(boundary, [{ name: "user", body: "bob" }]);
  const ctx = makeContext({
    url: new URL("http://127.0.0.1/upload"),
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    readBody: async () => latin1Bytes(body),
  });
  const form = await ctx.formData();
  check("multipart via makeContext", form instanceof FormData && form.get("user") === "bob");
}

{
  // RFC 7578 discourages filename* in multipart; Node 22 rejects it, Node 24+ may decode it.
  const starBody = buildMultipart("u", [
    { name: "f", filenameStar: "UTF-8''upload%2Etxt", body: "x" },
  ]);
  const starCt = "multipart/form-data; boundary=u";
  let starOk = false;
  let starStatus = 0;
  try {
    const fd = await parseMultipartBody(latin1Bytes(starBody), starCt);
    const f = fd.get("f");
    starOk = f instanceof File && f.name === "upload.txt";
  } catch (e) {
    starStatus = e.status ?? 0;
  }
  check(
    "filename* (UTF-8) when the platform supports it, else 400",
    starOk || starStatus === 400,
  );
}

{
  const fd = await parseMultipartBody(
    latin1Bytes(
      buildMultipart("q", [{ name: "f", filename: "report; final.pdf", body: "x" }]),
    ),
    "multipart/form-data; boundary=q",
  );
  check("quoted filename with semicolon", fd.get("f") instanceof File && fd.get("f").name === "report; final.pdf");
}

{
  const boundary = "nl";
  const body = buildMultipart(boundary, [{ name: "f", filename: "t.txt", body: "bytes end with newline\n" }]);
  const file = (await parseMultipartBody(latin1Bytes(body), `multipart/form-data; boundary=${boundary}`)).get("f");
  const bytes = file && (await file.arrayBuffer());
  check(
    "file content keeps trailing newline",
    bytes && new TextDecoder().decode(bytes) === "bytes end with newline\n",
  );
}

{
  const parts = [];
  for (let i = 0; i < 80; i++) parts.push({ name: `p${i}`, body: `${i}` });
  const boundary = "many";
  const form = await parseMultipartBody(
    latin1Bytes(buildMultipart(boundary, parts)),
    `multipart/form-data; boundary=${boundary}`,
  );
  check("many parts round trip", form.get("p0") === "0" && form.get("p79") === "79");
}

{
  const form = await parseMultipartBody(
    latin1Bytes(
      `--c\r\nContent-Disposition: form-data; name="x"\r\nContent-Type: text/plain; charset=not-a-real-charset\r\n\r\nx\r\n--c--\r\n`,
    ),
    "multipart/form-data; boundary=c",
  );
  check("unknown charset does not throw (platform fallback)", form.get("x") === "x");
}

check(
  "part without header/body separator → 400",
  await rejects(
    () =>
      parseMultipartBody(
        latin1Bytes(`--b\r\nContent-Disposition: form-data; name="a"\r\n--b\r\nContent-Disposition: form-data; name="b"\r\n\r\nok\r\n--b--\r\n`),
        "multipart/form-data; boundary=b",
      ),
    /FormData|malformed/i,
  ),
);

check("requestBodyResult 413 JSON", requestBodyResult({ name: "RequestBodyError", status: 413, message: "x" }, { json: true })?.status === 413);
check("requestBodyResult 400 plain", requestBodyResult({ name: "RequestBodyError", status: 400, message: "bad boundary" }, { dev: true })?.body === "bad boundary");

{
  const boundary = "stream";
  const req = new EventEmitter();
  req.headers = { "content-type": `multipart/form-data; boundary=${boundary}` };
  const ctx = makeContext({
    url: new URL("http://127.0.0.1/upload"),
    method: "POST",
    headers: req.headers,
    req,
  });
  const p = ctx.formData();
  req.emit("data", Buffer.alloc(2048));
  req.emit("data", Buffer.alloc(FORM_BODY_LIMIT));
  req.emit("end");
  let streamStatus = 0;
  try {
    await p;
  } catch (e) {
    streamStatus = e.status;
  }
  check("streamed read aborts over the byte limit (413)", streamStatus === 413);
}

{
  const table = {
    routes: [{ file: "routes/api/upload.ts", segments: [{ lit: "api" }, { lit: "upload" }], isApi: true }],
    layouts: [],
    middleware: [],
  };
  const modules = {
    "routes/api/upload.ts": {
      POST: async (ctx) => {
        await ctx.formData();
        return { ok: true };
      },
    },
  };
  const env = {
    dev: true,
    routeTable: async () => table,
    importModule: async (f) => modules[f],
    ensureIslands: async () => {},
    renderDocument: ({ body: b }) => b,
    renderError: (err) => ({ status: 500, body: String(err) }),
    onError: () => {},
  };
  const res = await handleRequest(env, {
    method: "POST",
    url: new URL("http://x.test/api/upload"),
    headers: { "content-type": "multipart/form-data", "content-length": String(20 * 1024 * 1024 + 1) },
    readBody: async () => new Uint8Array(0),
    version: 1,
  });
  check("handler maps oversized multipart to 413 on API routes", res.status === 413);
}

{
  const limit = 100;
  const req = new Request("http://127.0.0.1/", {
    method: "POST",
    body: new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(80));
        c.enqueue(new Uint8Array(80));
        c.close();
      },
    }),
    duplex: "half",
  });
  check(
    "readBodyWithLimit caps chunked Worker bodies",
    await rejects(() => readBodyWithLimit(req, {}, limit), /exceeds.*byte limit/),
  );
}

{
  const table = {
    routes: [{ file: "routes/api/upload.ts", segments: [{ lit: "api" }, { lit: "upload" }], isApi: true }],
    layouts: [],
    middleware: [],
  };
  const modules = {
    "routes/api/upload.ts": {
      POST: async (ctx) => {
        await ctx.formData();
        return { ok: true };
      },
    },
  };
  const env = {
    dev: true,
    routeTable: async () => table,
    importModule: async (f) => modules[f],
    ensureIslands: async () => {},
    renderDocument: ({ body: b }) => b,
    renderError: (err) => ({ status: 500, body: String(err) }),
    onError: () => {},
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const result = await handleRequest(env, { method: req.method, url, version: 1, req, headers: req.headers });
    res.writeHead(result.status ?? 200, result.headers ?? {});
    res.end(result.body ?? "");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const boundary = "sock";
  let httpStatus = 0;
  let reset = false;
  await new Promise((resolve) => {
    const piece = Buffer.alloc(64 * 1024, 0x61);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/api/upload",
        method: "POST",
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`,
          origin: `http://127.0.0.1:${port}`,
          "transfer-encoding": "chunked",
        },
      },
      (res) => {
        httpStatus = res.statusCode ?? 0;
        res.resume();
        resolve();
      },
    );
    req.on("error", () => {
      reset = true;
      resolve();
    });
    let sent = 0;
    const target = FORM_BODY_LIMIT + piece.length;
    const pump = () => {
      while (sent < target) {
        if (!req.write(piece)) {
          req.once("drain", pump);
          return;
        }
        sent += piece.length;
      }
      req.end();
    };
    pump();
  });
  server.close();
  check(
    "real-socket chunked upload over limit (413 or reset)",
    httpStatus === 413 || reset,
    `status=${httpStatus} reset=${reset}`,
  );
}

if (failures) process.exit(1);
console.log("all form-data checks passed");
