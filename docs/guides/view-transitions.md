# View Transitions

The client router can run a navigation inside `document.startViewTransition`, so the old page
cross-fades or morphs into the new one. It is opt-in, per link or per page, and adds nothing to
pages that don't use it.

## Per link

```tsx
import { Link } from "@nowaki-dev/runtime/navigation";

<Link viewTransition href="/posts">All posts</Link>
```

`<Link viewTransition>` renders `data-nowaki-transition`, which also works on a plain `<a>` or on
an element around several links:

```tsx
<nav data-nowaki-transition>
  <a href="/a">A</a> <a href="/b">B</a>
</nav>
```

## Per page

```tsx
// routes/vt/index.tsx
export const viewTransition = true;
```

Every client navigation to and from the page runs as a transition. The page also gets
`@view-transition { navigation: auto }`, so full page loads between two such pages (pages
without JavaScript, static output) get a cross-document transition in browsers that support it.

## Morph an element into the next page's

Give the element on both pages the same `view-transition-name` with `transitionName()`:

```tsx
// routes/posts/index.tsx
import { Image } from "@nowaki-dev/runtime/image";
import { Link, route, transitionName } from "@nowaki-dev/runtime/navigation";

<Link viewTransition href={route("/posts/[id]", { id: photo.id })}>
  <Image src={photo.image} alt={photo.title} width={120} style={transitionName(`photo-${photo.id}`)} />
</Link>;

// routes/posts/[id].tsx
<Image src={photo.image} alt={photo.title} style={transitionName(`photo-${photo.id}`)} />;
```

- `transitionName(name)` returns `{ viewTransitionName }` for a `style` prop. Characters that
  aren't valid in a CSS identifier become `_`, and a name starting with a digit or equal to a
  keyword (`none`, `auto`) gets a leading `_`.
- Names must be unique on a page: key them by the item.
- Spread it to combine styles: `style={{ ...transitionName(id), width: 320 }}`.
- Style the animation in CSS with `::view-transition-group(<name>)`, `::view-transition-old()` and
  `::view-transition-new()`.

## Direction

The transition carries the type `forward`, or `back` for a back navigation, for
`:active-view-transition-type()`:

```css
html:active-view-transition-type(back) ::view-transition-old(root) {
  animation-name: slide-out-right;
}
```

## When it is skipped

The page is swapped as usual, without a transition, when:

- the browser has no `document.startViewTransition`,
- the visitor prefers reduced motion (`prefers-reduced-motion: reduce`),
- the browser already animated a back gesture itself.

Hydration, page scripts and `nowaki:page-load` run after the new page is in. A navigation
superseded during a transition swaps nothing. Intercepting-route modals transition the same way.
The transition code is in the lazily loaded router chunk, and works under `NOWAKI_CSP=enforce`
and a basePath.

Working examples: `examples/hello/routes/vt/`, `examples/hello/islands/VtLink.tsx`,
`examples/gallery/routes/posts/`.

## Reference

- [Runtime API](../reference/runtime.md) (`Link` `viewTransition`, `transitionName`,
  `ViewTransition`)
- [Client events and attributes](../reference/client-events.md) (`data-nowaki-transition`)
