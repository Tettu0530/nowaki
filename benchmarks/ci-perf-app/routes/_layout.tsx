import "../styles/site.css";

export const meta = { openGraph: { siteName: "Nowaki perf" }, twitter: { site: "@nowaki_dev" } };

export default function RootLayout({ children }: { children: unknown }) {
  return (
    <div>
      <header>
        <nav>
          <a href="/">home</a>
          <a href="/posts/post-1">posts</a>
        </nav>
      </header>
      {children}
    </div>
  );
}
