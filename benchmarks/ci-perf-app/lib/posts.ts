const words = "wind rust island layout render stream route cache server page build loader".split(" ");

export type Post = { slug: string; title: string; date: string; tags: string[]; body: string[] };

export const posts: Post[] = Array.from({ length: 20 }, (_, i) => ({
  slug: `post-${i + 1}`,
  title: `Post ${i + 1}: ${words[i % words.length]} and ${words[(i * 5 + 3) % words.length]}`,
  date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
  tags: [words[i % words.length], words[(i + 4) % words.length]],
  body: Array.from({ length: 8 }, (_, p) =>
    Array.from({ length: 40 }, (_, w) => words[(i + p * 7 + w * 3) % words.length]).join(" ") + ".",
  ),
}));
