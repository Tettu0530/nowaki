// On-demand revalidation. The page is cached for 5 minutes (`revalidate`) and tagged (`tags`);
// the form's action purges it with revalidateTag (or revalidatePath), so the redirect after the
// POST already shows a fresh render instead of waiting out the 5 minutes.
import { revalidatePath, revalidateTag } from "@nowaki-dev/runtime";
import type { LoaderContext, PageProps } from "@nowaki-dev/runtime";

export const revalidate = 300;
export const tags = ["isr-demo"];

export const title = "On-demand ISR — Nowaki";

let renders = 0;

export const loader = async () => {
  renders += 1;
  return { renders };
};

export async function action(ctx: LoaderContext) {
  const form = await ctx.formData();
  const kind = String(form.get("kind") ?? "");
  if (kind === "path") revalidatePath("/isr-tagged");
  // A call after the response went out (a timer, a queue job) still reaches the cache, just later.
  else if (kind === "late") setTimeout(() => revalidateTag("isr-demo"), 50);
  else revalidateTag("isr-demo");
  return ctx.redirect("/isr-tagged", 303);
}

export default function IsrTagged({ data }: PageProps<typeof loader>) {
  return (
    <main style="font-family:sans-serif;max-width:640px;margin:4rem auto">
      <h1>On-demand ISR</h1>
      <p>
        render #<strong data-testid="isr-tagged-renders">{data.renders}</strong>
      </p>
      <form method="post">
        <button name="kind" value="tag">revalidateTag("isr-demo")</button>{" "}
        <button name="kind" value="path">revalidatePath("/isr-tagged")</button>
      </form>
      <a href="/">Back</a>
    </main>
  );
}
