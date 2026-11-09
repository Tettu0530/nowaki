import type { LoaderContext } from "@nowaki-dev/runtime";
import { posts, type Post } from "../../lib/posts.ts";
import Like from "../../islands/Like.tsx";
import "./post.css";

export const loader = (ctx: LoaderContext) => {
  const post = posts.find((p) => p.slug === ctx.params.slug);
  if (!post) return ctx.redirect("/");
  return post;
};

export const meta = ({ data }: { data: Post }) => ({
  title: `${data.title} — Nowaki perf`,
  description: data.body[0].slice(0, 150),
  canonical: true as const,
  openGraph: {
    type: "article",
    title: data.title,
    image: { url: `/og/${data.slug}.png`, width: 1200, height: 630, alt: data.title },
  },
});

export default function PostPage({ data }: { data: Post }) {
  return (
    <article class="post">
      <h1>{data.title}</h1>
      <time>{data.date}</time>
      <ul class="tags">
        {data.tags.map((t) => (
          <li>{t}</li>
        ))}
      </ul>
      {data.body.map((p) => (
        <p>{p}</p>
      ))}
      <Like slug={data.slug} />
    </article>
  );
}
