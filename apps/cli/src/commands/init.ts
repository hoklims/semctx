import { existsSync } from "node:fs";
import { join } from "node:path";
import { initWorkspace, openStore, isInitialized } from "@semantic-context/repository-store";
import type { ParsedArgs } from "../args";
import { flagBool, flagString } from "../args";
import { info, success, heading, json, c, warn } from "../output";
import { runPreset } from "./preset";

/** `semctx init` — create .semctx/, the SQLite db and config. Never touches app code. */
export function runInit(root: string, args: ParsedArgs): number {
  const preset = flagString(args, "preset");
  if (preset !== undefined) return runPreset(root, preset, args);

  const already = isInitialized(root);
  const detected = {
    typescript: existsSync(join(root, "tsconfig.json")),
    packageJson: existsSync(join(root, "package.json")),
    docs: existsSync(join(root, "docs")),
    migrations: existsSync(join(root, "migrations")),
    tests: existsSync(join(root, "test")) || existsSync(join(root, "tests")) || existsSync(join(root, "__tests__")),
  };

  const config = initWorkspace(root);
  openStore(root).close();

  if (flagBool(args, "json")) {
    json({ initialized: true, alreadyInitialized: already, root, detected, config });
    return 0;
  }

  if (already) warn("re-initialised existing .semctx/ (config rewritten, data preserved)");
  else success(`initialised .semctx/ at ${root}`);

  heading("Detected");
  info(`  TypeScript config : ${detected.typescript ? c.green("yes") : c.dim("no")}`);
  info(`  package.json      : ${detected.packageJson ? c.green("yes") : c.dim("no")}`);
  info(`  docs/             : ${detected.docs ? c.green("yes") : c.dim("no")}`);
  info(`  migrations/       : ${detected.migrations ? c.green("yes") : c.dim("no")}`);
  info(`  tests             : ${detected.tests ? c.green("yes") : c.dim("no")}`);
  info("");
  info(c.dim("Next: semctx index"));
  return 0;
}
