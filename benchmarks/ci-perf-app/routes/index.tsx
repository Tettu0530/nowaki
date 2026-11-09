import { posts } from "../lib/posts.ts";

export const title = "Nowaki perf";

export default function Home() {
  return (
    <main>
      <h1>Posts</h1>
      <ul>
        {posts.map((p) => (
          <li>
            <a href={`/posts/${p.slug}`}>{p.title}</a>
          </li>
        ))}
      </ul>
    </main>
  );
}
