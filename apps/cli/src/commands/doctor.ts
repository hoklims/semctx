import { isInitialized, loadConfig, openStore } from "@semantic-context/repository-store";
import type { ParsedArgs } from "../args";
import { flagBool } from "../args";
import { info, heading, json, c, success, fail } from "../output";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/** `semctx doctor` — verify the workspace is healthy and indexed. */
export function runDoctor(root: string, args: ParsedArgs): number {
  const checks: Check[] = [];

  const initialized = isInitialized(root);
  checks.push({ name: "workspace", ok: initialized, detail: initialized ? ".semctx/ present" : "run 'semctx init'" });

  let indexed = false;
  let nodeCount = 0;
  let claimCount = 0;
  let configOk = false;

  if (initialized) {
    try {
      loadConfig(root);
      configOk = true;
    } catch (cause) {
      configOk = false;
      checks.push({ name: "config", ok: false, detail: String(cause) });
    }
    if (configOk) checks.push({ name: "config", ok: true, detail: "config.json valid" });

    const store = openStore(root);
    indexed = store.isIndexed();
    nodeCount = Number(store.getMeta("node_count") ?? "0");
    claimCount = store.loadClaims().length;
    const indexedAt = store.getMeta("indexed_at");
    store.close();
    checks.push({
      name: "index",
      ok: indexed,
      detail: indexed ? `${nodeCount} nodes, ${claimCount} claims (indexed ${indexedAt ?? "?"})` : "run 'semctx index'",
    });
  }

  checks.push({ name: "runtime", ok: true, detail: `bun ${Bun.version}` });

  const healthy = checks.every((chk) => chk.ok);

  if (flagBool(args, "json")) {
    json({ healthy, checks });
    return healthy ? 0 : 1;
  }

  heading("Doctor");
  for (const chk of checks) {
    const mark = chk.ok ? c.green("ok ") : c.red("bad");
    info(`  [${mark}] ${chk.name.padEnd(10)} ${c.dim(chk.detail)}`);
  }
  info("");
  if (healthy) success("workspace healthy");
  else fail("workspace has issues (see above)");
  return healthy ? 0 : 1;
}
