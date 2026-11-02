import { defineConfig } from "astro/config";
import preact from "@astrojs/preact";

// Preact islands, to match Nowaki's conditions (same UI library).
export default defineConfig({
  integrations: [preact()],
});
