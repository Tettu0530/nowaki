// Runs nowaki-core route budget unit/integration tests (parse + build fixtures).
import { spawnSync } from "node:child_process";

const r = spawnSync("cargo", ["test", "-p", "nowaki-core", "budget::", "--quiet"], {
  stdio: "inherit",
});
process.exit(r.status === 0 ? 0 : 1);
