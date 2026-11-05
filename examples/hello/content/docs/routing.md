---
title: Routing
order: 2
---

# Routing

Each file under `routes/` is a page. `[slug].tsx` matches one segment.

- [x] Static routes
- [x] Dynamic routes

Code blocks are highlighted at build time, with no client JS:

```tsx
export default function Post({ data }: { data: { title: string } }) {
  return <h1>{data.title}</h1>;
}
```
