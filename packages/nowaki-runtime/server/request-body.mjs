// Typed errors for request-body limits and malformed multipart bodies (mapped to 4xx in handler.mjs).

export class RequestBodyError extends Error {
  constructor(message, { status = 400 } = {}) {
    super(message);
    this.name = "RequestBodyError";
    const n = Number(status);
    this.status = Number.isInteger(n) && n >= 400 && n <= 599 ? n : 400;
  }
}

export function requestBodyResult(err, { dev = false, json = false } = {}) {
  if (err?.name !== "RequestBodyError") return null;
  const status = err.status ?? 400;
  const message = status === 413 ? "Payload Too Large" : dev ? String(err.message) : "Bad Request";
  if (json) {
    return {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: message }),
    };
  }
  return {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
    body: message,
  };
}
