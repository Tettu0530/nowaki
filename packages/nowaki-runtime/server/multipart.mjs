// multipart/form-data parser for LoaderContext.formData(). Node reads the body with a byte cap
// while streaming (context.mjs readBodyNode); other runtimes buffer then enforce the limit. Full
// streaming uploads are future work. The boundary comes from Content-Type; length is capped at 70
// characters (RFC 2046).
import { RequestBodyError } from "./request-body.mjs";

const DEFAULT_BODY_LIMIT = 10 * 1024 * 1024;

function positiveInt(v, fallback) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export const FORM_BODY_LIMIT = positiveInt(globalThis.process?.env?.NOWAKI_FORM_BODY_LIMIT, DEFAULT_BODY_LIMIT);

function toUint8Array(buf) {
  if (buf instanceof Uint8Array) return buf;
  if (ArrayBuffer.isView(buf)) return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  if (typeof buf === "string") {
    const u = new Uint8Array(buf.length);
    for (let i = 0; i < buf.length; i++) u[i] = buf.charCodeAt(i) & 0xff;
    return u;
  }
  return new Uint8Array(buf);
}

function concat(...parts) {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function findSequence(hay, needle, from = 0) {
  if (needle.length === 0 || hay.length < needle.length) return -1;
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function skipOptionalCrlf(u8, pos) {
  if (pos + 1 < u8.length && u8[pos] === 0x0d && u8[pos + 1] === 0x0a) return pos + 2;
  if (pos < u8.length && u8[pos] === 0x0a) return pos + 1;
  return pos;
}

function headerBlockEnd(u8, start) {
  const crlf = findSequence(u8, new Uint8Array([0x0d, 0x0a, 0x0d, 0x0a]), start);
  if (crlf >= 0) return { headersEnd: crlf, bodyStart: crlf + 4 };
  const lf = findSequence(u8, new Uint8Array([0x0a, 0x0a]), start);
  if (lf >= 0) return { headersEnd: lf, bodyStart: lf + 2 };
  return null;
}

/** Media type is multipart/form-data (ignoring parameters). */
export function isMultipartFormData(contentType) {
  return (
    String(contentType ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase() === "multipart/form-data"
  );
}

function assertBoundaryLength(boundary) {
  if (!boundary || boundary.length > 70) {
    throw new RequestBodyError("multipart boundary must be 1-70 characters", { status: 400 });
  }
}

function badRequest(message) {
  return new RequestBodyError(message, { status: 400 });
}

function tooLarge(message) {
  return new RequestBodyError(message, { status: 413 });
}

/** Returns the boundary string, `null` when missing, or throws on an empty quoted boundary. */
export function boundaryFromContentType(contentType) {
  if (!isMultipartFormData(contentType)) return undefined;
  for (const piece of String(contentType).split(";").slice(1)) {
    const i = piece.indexOf("=");
    if (i < 0) continue;
    const k = piece.slice(0, i).trim().toLowerCase();
    if (k !== "boundary") continue;
    let v = piece.slice(i + 1).trim();
    if (!v) throw badRequest("multipart/form-data boundary is empty");
    if (v.startsWith('"')) {
      let out = "";
      for (let j = 1; j < v.length; j++) {
        const ch = v[j];
        if (ch === "\\" && j + 1 < v.length) {
          out += v[++j];
          continue;
        }
        if (ch === '"') break;
        out += ch;
      }
      if (!out) throw badRequest("multipart/form-data boundary is empty");
      assertBoundaryLength(out);
      return out;
    }
    assertBoundaryLength(v);
    return v;
  }
  return null;
}

function parseQuoted(s) {
  if (!s.startsWith('"')) return s;
  let out = "";
  for (let j = 1; j < s.length; j++) {
    const ch = s[j];
    if (ch === "\\" && j + 1 < s.length) {
      out += s[++j];
      continue;
    }
    if (ch === '"') return out;
    out += ch;
  }
  return out;
}

function parseDisposition(value) {
  const params = {};
  for (const piece of String(value).split(";").slice(1)) {
    const i = piece.indexOf("=");
    if (i < 0) continue;
    const k = piece.slice(0, i).trim().toLowerCase();
    let v = piece.slice(i + 1).trim();
    if (v.startsWith('"')) v = parseQuoted(v);
    else if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1);
    params[k] = v;
  }
  return params;
}

function normalizeCharsetLabel(charset) {
  const c = String(charset ?? "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  if (!c || c === "utf8") return "utf-8";
  if (c === "latin1" || c === "latin-1") return "iso-8859-1";
  return c;
}

function percentDecodeBytes(encoded) {
  const out = [];
  for (let i = 0; i < encoded.length; i++) {
    const ch = encoded[i];
    if (ch === "%") {
      if (i + 2 >= encoded.length) throw new Error("truncated % escape");
      const hex = encoded.slice(i + 1, i + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) throw new Error("invalid % escape");
      out.push(Number.parseInt(hex, 16));
      i += 2;
    } else {
      out.push(ch.charCodeAt(0) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/** RFC 5987 `charset'language'value` in Content-Disposition `filename*`. Returns null when invalid. */
export function decodeFilenameStar(value) {
  const m = /^([^']*)'([^']*)'(.*)$/s.exec(String(value ?? "").trim());
  if (!m) return null;
  let bytes;
  try {
    bytes = percentDecodeBytes(m[3]);
  } catch {
    return null;
  }
  const label = normalizeCharsetLabel(m[1]);
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    if (label === "iso-8859-1") {
      let s = "";
      for (const b of bytes) s += String.fromCharCode(b);
      return s;
    }
    return null;
  }
}

/** RFC 6266: `filename*` wins when decodable; else `filename`. */
export function filenameFromDisposition(params) {
  const star = params["filename*"];
  const plain = params.filename;
  if (star !== undefined) {
    const decoded = decodeFilenameStar(star);
    if (decoded !== null && decoded !== "") return decoded;
  }
  if (plain !== undefined) return plain;
  return undefined;
}

function charsetFromContentType(contentType) {
  const m = /(?:^|;)\s*charset=\s*"?([^";]+)"?/i.exec(String(contentType ?? ""));
  return m ? m[1].trim() : "utf-8";
}

function parsePartHeaders(text) {
  const headers = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    headers[k] = line.slice(i + 1).trim();
  }
  return headers;
}

function stripTrailingCrlf(u8) {
  if (u8.length >= 2 && u8[u8.length - 2] === 0x0d && u8[u8.length - 1] === 0x0a) {
    return u8.subarray(0, u8.length - 2);
  }
  if (u8.length >= 1 && u8[u8.length - 1] === 0x0a) {
    return u8.subarray(0, u8.length - 1);
  }
  return u8;
}

/**
 * @param {Uint8Array | ArrayBuffer | string} buf
 * @param {string} contentType
 * @param {{ bodyLimit?: number; fileLimit?: number }} [opts]
 * @returns {FormData}
 */
export function parseMultipartBody(buf, contentType, opts = {}) {
  const bodyLimit = opts.bodyLimit ?? FORM_BODY_LIMIT;
  const fileLimit = opts.fileLimit ?? bodyLimit;
  const u8 = toUint8Array(buf);
  if (u8.byteLength > bodyLimit) {
    throw tooLarge(`multipart body exceeds ${bodyLimit} byte limit`);
  }

  const boundary = boundaryFromContentType(contentType);
  if (boundary === undefined) {
    throw badRequest("expected multipart/form-data Content-Type");
  }
  if (boundary === null) {
    throw badRequest("multipart/form-data requires a boundary parameter");
  }

  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const boundaryBytes = enc.encode(boundary);
  const dashBoundary = concat(enc.encode("--"), boundaryBytes);
  const delim = concat(enc.encode("\r\n--"), boundaryBytes);
  const delimLf = concat(enc.encode("\n--"), boundaryBytes);
  const closeMarker = concat(dashBoundary, enc.encode("--"));
  const closeAfterCrlf = concat(enc.encode("\r\n"), closeMarker);

  let pos = findSequence(u8, dashBoundary, 0);
  if (pos < 0) throw badRequest("multipart body does not start with the boundary");
  pos += dashBoundary.length;
  if (pos + 1 < u8.length && u8[pos] === 0x2d && u8[pos + 1] === 0x2d) {
    return new FormData();
  }
  pos = skipOptionalCrlf(u8, pos);
  if (findSequence(u8, closeMarker, pos) === pos || findSequence(u8, closeAfterCrlf, pos) === pos) {
    return new FormData();
  }

  const form = new FormData();
  while (pos < u8.length) {
    const next = findNextDelimiter(u8, pos, delim, delimLf);
    if (next.at < 0) throw badRequest("multipart boundary not found in body");
    const partEnd = next.at;
    const afterBoundary = next.at + next.len;
    const isClose =
      afterBoundary + 1 < u8.length && u8[afterBoundary] === 0x2d && u8[afterBoundary + 1] === 0x2d;

    const heads = headerBlockEnd(u8, pos);
    if (!heads) throw badRequest("multipart part is missing a header block");
    const headerText = dec.decode(u8.subarray(pos, heads.headersEnd));
    const headers = parsePartHeaders(headerText);
    let body = u8.subarray(heads.bodyStart, partEnd);
    body = stripTrailingCrlf(body);

    const disp = headers["content-disposition"];
    if (disp?.toLowerCase().includes("form-data")) {
      const params = parseDisposition(disp);
      const { name } = params;
      const filename = filenameFromDisposition(params);
      if (name) {
        const isFile = filename !== undefined && filename !== "";
        if (isFile) {
          if (body.byteLength > fileLimit) {
            throw tooLarge(`multipart file "${filename}" exceeds ${fileLimit} byte limit`);
          }
          const type = headers["content-type"]?.split(";")[0]?.trim() || "application/octet-stream";
          form.append(name, new File([body.slice()], filename, { type }));
        } else {
          if (body.byteLength > fileLimit) {
            throw tooLarge(`multipart field "${name}" exceeds ${fileLimit} byte limit`);
          }
          const charset = charsetFromContentType(headers["content-type"]);
          form.append(name, new TextDecoder(charset).decode(body));
        }
      }
    }

    if (isClose) break;
    pos = afterBoundary;
    pos = skipOptionalCrlf(u8, pos);
  }
  return form;
}

function findNextDelimiter(u8, pos, delim, delimLf) {
  const a = findSequence(u8, delim, pos);
  const b = findSequence(u8, delimLf, pos);
  if (a < 0 && b < 0) return { at: -1, len: 0 };
  if (a < 0) return { at: b, len: delimLf.length };
  if (b < 0) return { at: a, len: delim.length };
  return a <= b ? { at: a, len: delim.length } : { at: b, len: delimLf.length };
}
