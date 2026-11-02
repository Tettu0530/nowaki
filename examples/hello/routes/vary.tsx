// ISR + header-dependent route. Used by the security e2e to verify cross-user cache isolation.
// It reads accept-language, so Vary learning puts that value in the cache key and
// a request in one language never gets content cached for another.
export const revalidate = 30;

export const loader = (ctx: { get: (name: string) => string | undefined }) => ({
  lang: ctx.get("accept-language") ?? "none",
});

type Data = { lang: string };

export default function Vary({ data }: { data: Data }) {
  return (
    <article>
      <h1>vary</h1>
      <p>LANG={data.lang}</p>
    </article>
  );
}
