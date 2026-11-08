// A page that imports a .mdoc file: @nowaki-dev/markdoc (nowaki.config.mjs) compiles it into a
// module at build time. `.mdoc` files aren't routes themselves.
import Page, { frontmatter, headings } from "../markdoc/page.mdoc";

export const title = "Markdoc — Nowaki";

export default function MarkdocPage() {
  return (
    <main style="max-width:40rem;margin:3rem auto;padding:0 1.25rem;font-family:system-ui">
      <nav data-testid="toc">
        {headings
          .filter((h) => h.depth === 2)
          .map((h) => (
            <a href={`#${h.id}`}>{h.text}</a>
          ))}
      </nav>
      <p data-testid="fm">{frontmatter.title}</p>
      <Page />
    </main>
  );
}
