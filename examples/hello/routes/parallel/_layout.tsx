// Parallel routes: @aside/ files render in `aside` without adding a URL segment.
export default function ParallelLayout({ children, aside }: { children: unknown; aside: unknown }) {
  return (
    <main data-testid="parallel-layout">
      <section data-testid="parallel-main">{children}</section>
      <aside data-testid="parallel-aside">{aside}</aside>
    </main>
  );
}
