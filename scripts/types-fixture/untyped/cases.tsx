// Type cases without `nowaki typegen` output (NowakiRoutes empty). Each one failed on the 0.20.0
// types; the @ts-expect-error lines must stay errors. Run by scripts/types-test.mjs.
import type { LayoutModule, Live, LoaderContext, PageProps } from "@nowaki-dev/runtime";
import { route } from "@nowaki-dev/runtime/navigation";

// Live: a room island needs no `state`; a plain one still does.
type Votes = { a: number; b: number };
export const roomLive: Live<Votes> = {
  room: (props: { id?: string }) => `poll:${props.id ?? "demo"}`,
  shared: (): Votes => ({ a: 0, b: 0 }),
  on: { vote: (votes) => ({ ...votes, a: votes.a + 1 }) },
};
export const sharedOnly: Live<Votes> = { shared: () => ({ a: 0, b: 0 }), on: {} };
export const plainLive: Live<{ n: number }> = { state: () => ({ n: 0 }), on: { inc: (s) => ({ n: s.n + 1 }) } };
// @ts-expect-error: without room or shared, `state` is required.
export const noState: Live<{ n: number }> = { on: {} };

// PageProps: a loader that can redirect still gives the page its data type.
export async function loader(ctx: LoaderContext) {
  if (!ctx.cookies.user) return ctx.redirect("/login");
  if (ctx.url.searchParams.has("raw")) return new Response("raw");
  return { user: ctx.cookies.user, count: 1 };
}
export function Page({ data }: PageProps<typeof loader>) {
  const user: string = data.user;
  return <p>{user} {data.count}</p>;
}

// route(): params are accepted before the first typegen.
export const href1 = route("/x/[id]", { id: "1" });
export const href2 = route("/about");

// <form action={serverFn}> (a "use server" export), and the attribute's own types otherwise.
declare function addTodoForm(form: { text?: string }): Promise<string[]>;
export const form1 = <form action={addTodoForm} method="post"><input name="text" /></form>;
export const form2 = <form action="/search"></form>;
// @ts-expect-error: a number is still not an action.
export const form3 = <form action={42}></form>;
// @ts-expect-error: other elements keep Preact's attribute types.
export const div1 = <div action={addTodoForm}></div>;

// client:* directives still type-check on components (nowaki-jsx.d.ts augments Preact's JSX).
function Counter(_: { start?: number }) {
  return <button>+</button>;
}
export const island = <Counter start={1} client:visible client:media="(min-width: 768px)" />;

// A layout's meta function receives its own loader data.
const layoutLoader = () => ({ site: "Nowaki" });
export const layout = {
  loader: layoutLoader,
  title: "Site",
  lang: "en",
  meta: ({ data }: { data: { site: string } }) => ({ openGraph: { siteName: data.site } }),
  default: ({ children }: { children?: unknown }) => <div>{children as any}</div>,
} satisfies LayoutModule<{ site: string }>;
