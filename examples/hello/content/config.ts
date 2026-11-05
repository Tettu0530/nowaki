// Content collections: each directory under content/ is one, declared here with a Standard
// Schema for its frontmatter. Any library works (zod, valibot, arktype); this schema is
// hand-written so the example has no dependency.
import { defineCollection } from "@nowaki-dev/runtime/content";

type Doc = { title: string; order: number; draft: boolean };

const doc = {
  "~standard": {
    version: 1 as const,
    vendor: "example",
    validate(v: unknown) {
      const d = (v ?? {}) as Record<string, unknown>;
      const issues = [];
      if (typeof d.title !== "string" || !d.title) issues.push({ message: "is required", path: ["title"] });
      if (typeof d.order !== "number") issues.push({ message: "must be a number", path: ["order"] });
      if (issues.length) return { issues };
      return { value: { title: d.title, order: d.order, draft: d.draft === true } as Doc };
    },
    types: undefined as unknown as { input: unknown; output: Doc },
  },
};

export const docs = defineCollection({ schema: doc });
