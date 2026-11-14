#!/usr/bin/env node
// Thin alias for `npx create-nowaki-app`. Importing create-nowaki is enough: it reads argv and runs.
// create-nowaki has no `main` or `exports`, so an explicit path avoids the "index" lookup
// DeprecationWarning.
import "create-nowaki/index.js";
