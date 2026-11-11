// multipart/form-data for LoaderContext.formData(). The capped buffer is parsed with the
// platform FormData implementation (Node 22+, Bun, Deno, Workers). Full streaming uploads are
// future work.
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

function enforceEntryLimits(form, limit) {
  for (const [name, value] of form.entries()) {
    if (value instanceof File) {
      if (value.size > limit) {
        throw tooLarge(`multipart file "${value.name}" exceeds ${limit} byte limit`);
      }
    } else if (typeof value === "string") {
      const bytes = new TextEncoder().encode(value).byteLength;
      if (bytes > limit) {
        throw tooLarge(`multipart field "${name}" exceeds ${limit} byte limit`);
      }
    }
  }
}

/**
 * @param {Uint8Array | ArrayBuffer | string} buf
 * @param {string} contentType
 * @param {{ bodyLimit?: number }} [opts]
 * @returns {Promise<FormData>}
 */
export async function parseMultipartBody(buf, contentType, opts = {}) {
  const bodyLimit = opts.bodyLimit ?? FORM_BODY_LIMIT;
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

  try {
    const res = new Response(u8, { headers: { "content-type": contentType } });
    const form = await res.formData();
    enforceEntryLimits(form, opts.fileLimit ?? bodyLimit);
    return form;
  } catch (err) {
    if (err instanceof RequestBodyError) throw err;
    throw badRequest(err instanceof Error ? err.message : "multipart body is malformed");
  }
}
