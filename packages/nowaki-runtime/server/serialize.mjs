// Deterministically serializes island props (fixed key order, independent of insertion order).

export function stableStringify(value) {
  return stringify(value);
}

function stringify(v) {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) {
    return "[" + v.map(stringify).join(",") + "]";
  }
  if (typeof v.toJSON === "function") return stringify(v.toJSON());
  const keys = Object.keys(v).sort();
  const parts = [];
  for (const k of keys) {
    const val = v[k];
    if (val === undefined) continue; // omit undefined, like JSON
    parts.push(JSON.stringify(k) + ":" + stringify(val));
  }
  return "{" + parts.join(",") + "}";
}
