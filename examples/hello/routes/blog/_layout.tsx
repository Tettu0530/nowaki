// Nested layout wrapping only blog/ (sits inside the root _layout).
export default function BlogLayout({ children }: { children: unknown }) {
  return (
    <section style="border-left:3px solid #4a9;padding-left:1rem">
      <p style="color:#4a9;font-size:.85rem;margin:0 0 .5rem">blog section</p>
      {children}
    </section>
  );
}
