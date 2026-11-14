// A multipart/form-data upload: ctx.formData() returns FormData, and a file part is a File (name,
// type, bytes; treat the name as untrusted). The body is capped by NOWAKI_FORM_BODY_LIMIT. Fixture
// for scripts/security-e2e.mjs and scripts/form-data-test.mjs.
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
