// The top-level _layout.tsx wraps every page (nestable). Shared nav + footer.
// CSS a layout or route imports is linked in the page head (as /_nowaki/site.<hash>.css).
import "../styles/site.css";

// Attributes on <body> for every page; a route's own bodyAttrs merge over these (class is joined).
export const bodyAttrs = { class: "site", "data-site": "hello" };

export default function RootLayout({
  children,
  url,
}: {
  children: unknown;
  url: URL;
}) {
  return (
    <div style="font-family:sans-serif;max-width:680px;margin:0 auto;padding:2rem 1rem">
      <header style="display:flex;gap:1rem;border-bottom:1px solid #ddd;padding-bottom:.5rem;margin-bottom:1.5rem">
        <a href="/">home</a>
        <a href="/about">about</a>
        <a href="/todos">todos</a>
        <a href="/blog/hello">blog</a>
      </header>
      {children}
      <footer style="margin-top:2rem;border-top:1px solid #ddd;padding-top:.5rem;color:#888;font-size:.85rem">
        Nowaki demo · {url.pathname}
      </footer>
    </div>
  );
}
