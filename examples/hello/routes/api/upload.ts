// Multipart smoke route for security-e2e (multipart/form-data via ctx.formData()).
import type { LoaderContext } from "@nowaki-dev/runtime";

export async function POST(ctx: LoaderContext) {
  const form = await ctx.formData();
  const file = form.get("file");
  return {
    hasFile: file instanceof File,
    name: file instanceof File ? file.name : null,
    field: typeof form.get("note") === "string" ? form.get("note") : null,
  };
}
