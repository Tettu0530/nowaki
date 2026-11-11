// Shared request-body size gate for Edge/Worker adapters (Node uses readBodyNode in context.mjs).
import { FORM_BODY_LIMIT } from "./multipart.mjs";
import { RequestBodyError } from "./request-body.mjs";

function tooLarge(limit = FORM_BODY_LIMIT) {
  return new RequestBodyError(`request body exceeds ${limit} byte limit`, { status: 413 });
}

/** Reject oversize bodies before buffering (Workers `arrayBuffer()` has no streaming cap). */
export async function readBodyWithLimit(request, headers, limit = FORM_BODY_LIMIT) {
  const len = Number(headers["content-length"]);
  if (Number.isFinite(len) && len > limit) {
    throw tooLarge(limit);
  }
  const buf = new Uint8Array(await request.arrayBuffer());
  if (buf.byteLength > limit) {
    throw tooLarge(limit);
  }
  return buf;
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
