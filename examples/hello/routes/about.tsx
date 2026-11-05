export const title = "About — Nowaki";

// A content page: the build fails if an island ever makes it ship client JS.
export const budget = { js: 0 };

export default function About() {
  return (
    <main style="font-family:sans-serif;max-width:640px;margin:4rem auto">
      <h1>About</h1>
      <p>This page has no islands, so not a single byte of hydration JS is sent.</p>
      <a href="/">Back</a>
    </main>
  );
}
