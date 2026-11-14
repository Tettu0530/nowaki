// Multipart smoke route for security-e2e (multipart/form-data via ctx.formData()).
import type { LoaderContext } from "@nowaki-dev/runtime";

export async function POST(ctx: LoaderContext) {
  const form = await ctx.formData();
  const file = form.get("file");
  const note = form.get("note");
  return {
    hasFile: file instanceof File,
    name: file instanceof File ? file.name : null,
    field: typeof note === "string" ? note : null,
  };
}
