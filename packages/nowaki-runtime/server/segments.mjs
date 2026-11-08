// The route segment grammar, shared by the router (router.mjs) and config rules (rules.mjs).
// Runtime-neutral: no node: imports, so it runs on the edge too.
//   about     a literal (compared percent-decoded)
//   [slug]    any one segment
//   [card].png  one segment ending in .png (param = the part before it)
//   [...rest] the remaining segments (one or more), last only

/// One route segment, or one directory name of a convention-file prefix.
export function parseSegment(seg) {
  const rest = seg.match(/^\[\.\.\.(.+)\]$/); // [...slug] = catch-all
  if (rest) return { param: rest[1], rest: true };
  // [card].png: a param with a fixed extension after it (file routes)
  const suffixed = seg.match(/^\[([^\].]+)\](\.[^/]+)$/);
  if (suffixed) return { param: suffixed[1], suffix: suffixed[2] };
  const m = seg.match(/^\[(.+)\]$/);
  return m ? { param: m[1] } : { lit: seg };
}

/// A path segment, percent-decoded; null when its escapes are malformed ("50%", "%E0%A4").
export function decodeSegment(seg) {
  try {
    return decodeURIComponent(seg);
  } catch {
    return null;
  }
}

/// Matches parsed segments against a path's non-empty, already decoded parts (decodeSegment).
/// Returns the params, or null. A catch-all param is an array of the remaining parts.
export function matchSegments(segs, parts) {
  const rest = segs.length > 0 && segs[segs.length - 1].rest;
  if (rest) {
    // A trailing catch-all collects the rest (≥1). Fixed part = segs.length - 1.
    if (parts.length < segs.length) return null;
  } else if (segs.length !== parts.length) {
    return null;
  }
  const params = {};
  const fixed = rest ? segs.length - 1 : segs.length;
  for (let i = 0; i < fixed; i++) {
    const seg = segs[i];
    const part = parts[i];
    if (seg.lit !== undefined) {
      if (seg.lit !== part) return null;
    } else if (seg.suffix !== undefined) {
      if (part.length <= seg.suffix.length || !part.endsWith(seg.suffix)) return null;
      params[seg.param] = part.slice(0, -seg.suffix.length);
    } else {
      params[seg.param] = part;
    }
  }
  if (rest) params[segs[segs.length - 1].param] = parts.slice(fixed);
  return params;
}
