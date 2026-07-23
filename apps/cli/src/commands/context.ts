import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { SemctxError } from "@semantic-context/core";
import type { TaskFrame } from "@semantic-context/core";
import { trustedControlSealHash } from "@semantic-context/app-services";
import { openStore, contextPacksDir, loadConfig } from "@semantic-context/repository-store";
import { prepareContextPack, fetchProviderCandidates, stableProviderSourceSeal } from "@semantic-context/context-engine";
import type { ParsedArgs } from "../args";
import { flagBool } from "../args";
import { info, success, json, c, nowIso } from "../output";
import { renderPackMarkdown, renderPackConsole } from "../render-pack";

/** `semctx context prepare <task-id>` — compile a TaskFrame into a ContextPack. */
export async function runContextPrepare(root: string, args: ParsedArgs): Promise<number> {
  const taskId = args.positionals[2];
  const config = loadConfig(root);
  const sourceSealBefore = trustedControlSealHash(root);
  const store = openStore(root);

  if (!store.isIndexed()) {
    store.close();
    throw new SemctxError("REPO_NOT_INDEXED", "repository is not indexed; run 'semctx index' first");
  }

  let taskFrame: TaskFrame | undefined;
  if (taskId !== undefined) {
    taskFrame = store.getTaskFrame(taskId);
    if (taskFrame === undefined) {
      store.close();
      throw new SemctxError("TASK_NOT_FOUND", `no task frame with id ${taskId}`, { taskId });
    }
  } else {
    const frames = store.listTaskFrames();
    taskFrame = frames[0];
    if (taskFrame === undefined) {
      store.close();
      throw new SemctxError("TASK_NOT_FOUND", "no task frames exist; run 'semctx task create' first");
    }
  }

  const graph = store.loadGraph();
  const evidence = store.loadEvidence();
  const claims = store.loadClaims();
  const capturedAt = nowIso();
  const providerInput = { query: taskFrame.rawTask, repositoryRoot: config.repositoryRoot, limit: 20 };
  const providerCandidates = await fetchProviderCandidates(
    config,
    providerInput.query,
    providerInput.limit,
    sourceSealBefore !== undefined ? { sourceRepositorySealHash: sourceSealBefore, capturedAt } : undefined,
  );
  const sourceSealAfter = trustedControlSealHash(root);
  const stableSourceSeal = stableProviderSourceSeal(sourceSealBefore, sourceSealAfter);
  let pack = prepareContextPack({
    graph,
    evidence,
    claims,
    taskFrame,
    now: capturedAt,
    providerCandidates,
    providerInput,
    ...(stableSourceSeal !== undefined ? { expectedProviderSourceSealHash: stableSourceSeal } : {}),
  });
  if (stableSourceSeal !== undefined && stableProviderSourceSeal(stableSourceSeal, trustedControlSealHash(root)) === undefined) {
    pack = prepareContextPack({ graph, evidence, claims, taskFrame, now: capturedAt, providerCandidates, providerInput });
  }
  store.saveContextPack(pack);
  store.close();

  const dir = contextPacksDir(root);
  mkdirSync(dir, { recursive: true });
  const safeId = taskFrame.id.replace(/[^A-Za-z0-9._-]/g, "_");
  const jsonPath = join(dir, `${safeId}.json`);
  const mdPath = join(dir, `${safeId}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(pack, null, 2)}\n`, "utf8");
  writeFileSync(mdPath, renderPackMarkdown(pack), "utf8");

  if (flagBool(args, "json")) {
    json(pack);
    return 0;
  }

  renderPackConsole(pack);
  info("");
  success(`context pack written to .semctx/context-packs/${safeId}.{json,md}`);
  info(c.dim(`  ${jsonPath}`));
  return 0;
}
