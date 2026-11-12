// Server-side log lines. With NOWAKI_LOG=json each line is one JSON object (time, level, msg,
// source, trace_id, span_id, plus the error), the shape `nowaki start` writes too (obs.rs `log`);
// otherwise they read as before (`[nowaki] …` with the error and its stack). Only logs carry error
// details: what reaches a client stays generic. Runtime-neutral (no node: imports).

const JSON_MODE = String(globalThis.process?.env?.NOWAKI_LOG ?? "").trim().toLowerCase() === "json";

export const jsonLogs = () => JSON_MODE;

// The running request's context (functions.mjs publishes the accessor), for its trace ids.
const currentTrace = () => globalThis[Symbol.for("nowaki.context")]?.()?.__trace;

/// `scope` picks the text prefix (`[nowaki]`, `[nowaki live]`); `trace` defaults to the request's.
export function logLine(level, msg, err, { scope, trace, fields } = {}) {
  if (!JSON_MODE) {
    const prefix = scope ? `[nowaki ${scope}]` : "[nowaki]";
    const write = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    const text = msg ? `${prefix} ${msg}` : prefix;
    if (err === undefined) write(text);
    else write(text, err);
    return;
  }
  const tr = trace ?? currentTrace();
  const line = {
    time: new Date().toISOString(),
    level,
    msg: msg || String(err?.message ?? err ?? ""),
    source: scope ? `node:${scope}` : "node",
  };
  const traceId = tr?.traceId;
  if (traceId) {
    line.trace_id = traceId;
    line.span_id = tr.spanId;
  }
  if (fields) Object.assign(line, fields);
  if (err !== undefined) {
    line.error = err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err);
  }
  let text;
  try {
    text = JSON.stringify(line);
  } catch {
    text = JSON.stringify({ time: line.time, level, msg: line.msg, source: line.source });
  }
  (level === "error" ? console.error : console.log)(text);
}

export const logError = (msg, err, opts) => logLine("error", msg, err, opts);
export const logWarn = (msg, opts) => logLine("warn", msg, undefined, opts);
