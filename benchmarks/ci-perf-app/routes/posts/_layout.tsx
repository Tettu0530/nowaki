import "./posts.css";

export default function PostsLayout({ children }: { children: unknown }) {
  return (
    <main class="posts">
      <aside>posts</aside>
      {children}
    </main>
  );
}
