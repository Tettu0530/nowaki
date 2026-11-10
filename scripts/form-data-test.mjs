// multipart/form-data parsing for LoaderContext.formData(). No server needed.
import { EventEmitter } from "node:events";
import { makeContext } from "../packages/nowaki-runtime/server/context.mjs";
import { handleRequest } from "../packages/nowaki-runtime/server/handler.mjs";
import { requestBodyResult } from "../packages/nowaki-runtime/server/request-body.mjs";
import {
  FORM_BODY_LIMIT,
  boundaryFromContentType,
  decodeFilenameStar,
  filenameFromDisposition,
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
  const form = parseMultipartBody(latin1Bytes(body), ct);
  check("text field", form.get("title") === "hello");
  check("duplicate names (getAll)", form.getAll("tags").join(",") === "a,b");
  const file = form.get("pic");
  check("file is a File", file instanceof File);
  check("file name", file?.name === "x.png");
  check("file type", file?.type === "image/png");
  check("file bytes", file && (await file.arrayBuffer()).byteLength === 4);
}

check(
  "invalid body: boundary not in payload",
  await rejects(
    () => parseMultipartBody(latin1Bytes("not multipart"), "multipart/form-data; boundary=x"),
    /does not start with the boundary/,
  ),
);
check(
  "missing boundary parameter",
  await rejects(() => parseMultipartBody(latin1Bytes("--x\r\n\r\n"), "multipart/form-data"), /requires a boundary/),
);
check(
  "file size limit",
  await rejects(
    () =>
      parseMultipartBody(
        latin1Bytes(buildMultipart("z", [{ name: "f", filename: "big.bin", body: "0123456789" }])),
        "multipart/form-data; boundary=z",
        { fileLimit: 5 },
      ),
    /exceeds 5 byte/,
  ),
);
check(
  "empty multipart body",
  parseMultipartBody(latin1Bytes("--bbb\r\n--bbb--\r\n"), "multipart/form-data; boundary=bbb").get("x") === null,
);
check(
  "empty filename → text field",
  parseMultipartBody(
    latin1Bytes(
      '--e\r\nContent-Disposition: form-data; name="f"; filename=""\r\n\r\nplain\r\n--e--\r\n',
    ),
    "multipart/form-data; boundary=e",
  ).get("f") === "plain",
);
check(
  "wrong boundary in header",
  await rejects(
    () => parseMultipartBody(latin1Bytes("--aaa\r\n--aaa--\r\n"), "multipart/form-data; boundary=bbb"),
    /does not start with the boundary/,
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
    readBody: async () => new TextEncoder().encode("user=alice&n=1"),
  });
  const form = await ctx.formData();
  check("urlencoded still returns URLSearchParams", form instanceof URLSearchParams);
  check("urlencoded get", form.get("user") === "alice");
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
  const fd = parseMultipartBody(
    latin1Bytes(
      '--u\r\nContent-Disposition: form-data; name="f"; filename*=UTF-8\'\'upload%2Etxt\r\n\r\nx\r\n--u--\r\n',
    ),
    "multipart/form-data; boundary=u",
  );
  const f = fd.get("f");
  check("filename* (RFC 5987 UTF-8)", f instanceof File && f.name === "upload.txt");
}

check(
  "filename* with language tag",
  decodeFilenameStar("UTF-8'ja'%E3%81%82%E3%81%84.jpg") === "\u3042\u3044.jpg",
);
check(
  "filename* ISO-8859-1",
  decodeFilenameStar("ISO-8859-1''%E9%2Etxt") === "\u00e9.txt",
);
check(
  "filename* default charset (empty, UTF-8 default)",
  decodeFilenameStar("''%C2%A9.png") === "\u00a9.png",
);
check("filename* invalid % escape", decodeFilenameStar("UTF-8''%E") === null);
check(
  "filename* priority over filename (RFC 6266)",
  filenameFromDisposition({ filename: "fallback.bin", "filename*": "UTF-8''real%2Etxt" }) === "real.txt",
);
check(
  "filename fallback when filename* is invalid",
  filenameFromDisposition({ filename: "fallback.bin", "filename*": "nope" }) === "fallback.bin",
);
check(
  "filename only",
  filenameFromDisposition({ filename: "plain.csv" }) === "plain.csv",
);

{
  const fd = parseMultipartBody(
    latin1Bytes(
      '--p\r\nContent-Disposition: form-data; name="f"; filename="wrong"; filename*=UTF-8\'\'%E6%97%A5%E6%9C%AC.txt\r\n\r\nx\r\n--p--\r\n',
    ),
    "multipart/form-data; boundary=p",
  );
  check(
    "multipart: filename* wins over filename",
    fd.get("f") instanceof File && fd.get("f").name === "\u65e5\u672c.txt",
  );
}

{
  const fd = parseMultipartBody(
    latin1Bytes(
      '--fb\r\nContent-Disposition: form-data; name="f"; filename="keep.me"; filename*=bad\r\n\r\nx\r\n--fb--\r\n',
    ),
    "multipart/form-data; boundary=fb",
  );
  check("multipart: invalid filename* uses filename", fd.get("f") instanceof File && fd.get("f").name === "keep.me");
}

check(
  "LF-only delimiters",
  parseMultipartBody(
    latin1Bytes(
      '--lf\r\nContent-Disposition: form-data; name="a"\r\n\r\none\n--lf\r\nContent-Disposition: form-data; name="b"\r\n\r\ntwo\n--lf--\r\n',
    ),
    "multipart/form-data; boundary=lf",
  ).get("b") === "two",
);

check(
  "text part charset",
  parseMultipartBody(
    latin1Bytes(
      `--c\r\nContent-Disposition: form-data; name="x"\r\nContent-Type: text/plain; charset=iso-8859-1\r\n\r\n\xe9\r\n--c--\r\n`,
    ),
    "multipart/form-data; boundary=c",
  ).get("x") === "\u00e9",
);

check("requestBodyResult 413 JSON", requestBodyResult({ name: "RequestBodyError", status: 413, message: "x" }, { json: true })?.status === 413);
check("requestBodyResult 400 plain", requestBodyResult({ name: "RequestBodyError", status: 400, message: "bad boundary" }, { dev: true })?.body === "bad boundary");

{
  const { FORM_BODY_LIMIT } = await import("../packages/nowaki-runtime/server/multipart.mjs");
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
  const boundary = "api";
  const body = `--${boundary}\r\n--${boundary}--\r\n`;
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

if (failures) process.exit(1);
console.log("all form-data checks passed");
