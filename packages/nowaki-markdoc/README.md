# @nowaki-dev/markdoc

[Markdoc](https://markdoc.dev) for [Nowaki](https://nowaki.dev). `.mdoc` files compile to Preact
modules at build and dev time: Markdoc parses, validates and transforms them in Nowaki's plugin
host, and the module ships only the resulting tree plus a small renderer. No Markdoc code reaches
the server bundle or the browser.

```sh
npm install @nowaki-dev/markdoc
```

```js
// nowaki.config.mjs
import { markdoc } from "@nowaki-dev/markdoc";

export default {
  plugins: [
    markdoc({
      components: "./markdoc/components.tsx",
      tags: {
        callout: { render: "Callout", attributes: { type: { type: String, matches: ["note", "warning"] } } },
      },
    }),
  ],
};
```

```tsx
// markdoc/components.tsx: capitalized `render` names are this module's exports
export function Callout({ type = "note", children }) {
  return <aside class={`callout callout-${type}`}>{children}</aside>;
}
```

```tsx
// routes/guide.tsx
import Guide, { frontmatter, headings } from "../content/guide.mdoc";

export default function Page() {
  return <Guide />;
}
```

## Options

- `components`: path (from the app root) to the module whose exports render capitalized tag
  names. An island exported here hydrates as usual. Required once a schema renders a component.
- `tags`, `nodes`: Markdoc schemas. `render` is a string, either a lowercase HTML element or a
  component name.
- `variables`, `functions`, `partials`: passed to Markdoc. `$frontmatter` holds the file's own
  frontmatter.
- `parseFrontmatter(raw, format)`: a full YAML / TOML parser. The built-in reader handles flat
  `key: value` (YAML, `---`) and `key = value` (TOML, `+++`) pairs and lists of scalars. Anything
  else is an error that points at this option.

## What a module exports

- `default`: a component that renders the document.
- `frontmatter`: the parsed frontmatter.
- `headings`: `{ depth, text, id }[]`. Each heading gets an id from its text, the same ids Nowaki
  gives Markdown and MDX headings, unless it has `{% #id %}`.

## Content collections

`.mdoc` files under `content/` are entries like `.mdx` ones. Nowaki reads their frontmatter (YAML
or TOML) in Rust for `data`, and `entry.render()` returns `{ Content, headings }` from the
compiled module. The entry itself has no `headings` until rendered.

## Safety

- Validation errors (an unknown tag, a bad attribute) fail the build, naming the file and line.
- Markdoc has no raw HTML: `<script>` in a document is text. Text and attribute values are escaped
  by Preact.
- The renderer refuses `script`, `style`, `iframe`, `object`, `embed`, `base`, `meta`, `link`,
  `template` and frame elements, drops `on*` attributes, and drops `javascript:`, `vbscript:`
  and `data:` URLs in `href` / `src`-style attributes.
- A capitalized name renders only an own export of the `components` module. Anything else is an
  error.

`.mdoc` files are not routes. Import them from a page.

## License

MIT. Markdoc itself is MIT, by Stripe.
