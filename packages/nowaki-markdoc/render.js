// Renders a serialized Markdoc tree (emitted by the plugin at build time) with Preact. No Markdoc
// runtime ships: the tree is plain data, `[name, attributes, children]` for a tag (an empty name
// for a fragment) and a string for text. Preact escapes text and attribute values; nothing here sets raw HTML.

import { h, Fragment } from "preact";

const ELEMENT = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const COMPONENT = /^[A-Z][A-Za-z0-9_$]*(?:\.[A-Z][A-Za-z0-9_$]*)*$/;
const ATTRIBUTE = /^[A-Za-z_:][A-Za-z0-9_.:-]*$/;
// Elements a schema could name that would run code or change the document if content reached them.
const BLOCKED_ELEMENTS = new Set(["script", "style", "iframe", "frame", "frameset", "object", "embed", "base", "meta", "link", "template"]);
const URL_ATTRIBUTES = new Set(["href", "src", "action", "formaction", "xlink:href", "poster", "cite", "background"]);
// Browsers ignore ASCII whitespace and control characters inside a scheme (`java\tscript:`).
const UNSAFE_URL = /^(?:javascript|vbscript|data):/i;

function safeUrl(value) {
  return !UNSAFE_URL.test(String(value).replace(/[\u0000- \u007f]/g, ""));
}

function elementProps(attributes) {
  const props = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!ATTRIBUTE.test(key) || /^on/i.test(key)) continue;
    if (value == null || value === false) continue;
    if (typeof value !== "string" && typeof value !== "number" && value !== true) continue;
    if (URL_ATTRIBUTES.has(key.toLowerCase()) && !safeUrl(value)) continue;
    props[key] = value;
  }
  return props;
}

function componentProps(attributes) {
  const props = { ...attributes };
  delete props.dangerouslySetInnerHTML;
  return props;
}

function lookup(components, name) {
  let value = components;
  for (const part of name.split(".")) {
    if (value == null || !Object.prototype.hasOwnProperty.call(value, part)) return undefined;
    value = value[part];
  }
  return value;
}

// Turns a serialized tree into Preact nodes. `components` is the namespace of the module named by
// the plugin's `components` option; a capitalized tag name must be one of its exports.
export function renderMarkdoc(node, components = {}) {
  if (node == null || typeof node === "boolean") return null;
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!Array.isArray(node) || typeof node[0] !== "string") return null;
  const [name, attributes = {}, children = []] = node;
  const kids = children.map((n) => renderMarkdoc(n, components));
  if (name === "") return h(Fragment, null, ...kids);
  if (COMPONENT.test(name)) {
    const component = lookup(components, name);
    if (typeof component !== "function") {
      throw new Error(`[nowaki-markdoc] component "${name}" is not exported from the markdoc components module`);
    }
    return h(component, componentProps(attributes), ...kids);
  }
  if (!ELEMENT.test(name) || BLOCKED_ELEMENTS.has(name)) {
    throw new Error(`[nowaki-markdoc] refusing to render the element <${name}>`);
  }
  return h(name, elementProps(attributes), ...kids);
}
