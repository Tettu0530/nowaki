// Request-body size checks. context.mjs uses the Content-Length and buffered-size checks on every
// runtime; readBodyWithLimit reads a Web Request's body (web.mjs), where Node uses readBodyNode in
// context.mjs.
import { FORM_BODY_LIMIT } from "./multipart.mjs";
import { RequestBodyError } from "./request-body.mjs";

function tooLarge(limit = FORM_BODY_LIMIT) {
  return new RequestBodyError(`request body exceeds ${limit} byte limit`, { status: 413 });
}

/**
 * Reads a Web Request's body, rejecting (413) one over `limit` bytes while streaming, chunked
 * bodies without Content-Length included.
 */
export async function readBodyWithLimit(request, headers, limit = FORM_BODY_LIMIT) {
  const len = Number(headers["content-length"]);
  if (Number.isFinite(len) && len > limit) {
    throw tooLarge(limit);
  }
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        try {
          await reader.cancel();
        } catch {
          /* stream already errored */
        }
        throw tooLarge(limit);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

export function assertBufferedBodySize(buf, limit = FORM_BODY_LIMIT) {
  const u8 =
    buf instanceof Uint8Array
      ? buf
      : typeof buf === "string"
        ? new TextEncoder().encode(buf)
        : new Uint8Array(buf);
  if (u8.byteLength > limit) {
    throw tooLarge(limit);
  }
  return buf;
}

export function contentLengthOverLimit(headers, limit = FORM_BODY_LIMIT) {
  const len = Number(headers["content-length"]);
  return Number.isFinite(len) && len > limit;
}
