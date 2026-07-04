import { TaskModeSchema } from "@semantic-context/core";
import type { TaskFrame, ContextPack, TaskFrameInput, TaskMode } from "@semantic-context/core";
import { isInitialized, initWorkspace, loadConfig, openStore } from "@semantic-context/repository-store";
import type { SqliteRepositoryStore } from "@semantic-context/repository-store";
import {
  GraphIndex,
  analyzeAndBuildClaims,
  extractionContext,
  defaultTaskExtractor,
  prepareContextPack,
  fetchProviderCandidates,
  inspectGraph,
  analyzeDiff,
  type InspectionResult,
  type VerifyResult,
  type InspectKind,
} from "@semantic-context/context-engine";

function nowIso(): string {
  return new Date().toISOString();
}

/** Ensure the repo is initialised and indexed; return an open store. */
function ensureReady(root: string): SqliteRepositoryStore {
  if (!isInitialized(root)) initWorkspace(root);
  const config = loadConfig(root);
  const store = openStore(root);
  if (!store.isIndexed()) {
    const { analysis, claims } = analyzeAndBuildClaims(config);
    store.saveGraph(analysis.graph, analysis.evidence);
    store.replaceClaims(claims);
  }
  return store;
}

export interface PrepareTaskResult {
  taskFrame: TaskFrame;
  contextPack: ContextPack;
}

/** semctx_prepare_task: raw task -> TaskFrame + ContextPack. */
export async function prepareTaskTool(root: string, input: { task: string; mode?: string }): Promise<PrepareTaskResult> {
  const store = ensureReady(root);
  try {
    const config = loadConfig(root);
    const graph = store.loadGraph();
    const seed: TaskFrameInput = { rawTask: input.task };
    if (input.mode !== undefined) {
      const parsed = TaskModeSchema.safeParse(input.mode);
      if (parsed.success) seed.mode = parsed.data as TaskMode;
    }
    const taskFrame = defaultTaskExtractor.extract(seed, extractionContext(graph, nowIso()));
    store.saveTaskFrame(taskFrame);
    const providerCandidates = await fetchProviderCandidates(config, taskFrame.rawTask);
    const contextPack = prepareContextPack({
      graph,
      evidence: store.loadEvidence(),
      claims: store.loadClaims(),
      taskFrame,
      now: nowIso(),
      providerCandidates,
    });
    store.saveContextPack(contextPack);
    return { taskFrame, contextPack };
  } finally {
    store.close();
  }
}

/** semctx_inspect: inspect the graph around a query. */
export function inspectTool(root: string, input: { query: string; kind?: string }): InspectionResult {
  const store = ensureReady(root);
  try {
    const kind = normalizeKind(input.kind);
    return inspectGraph({
      graph: store.loadGraph(),
      claims: store.loadClaims(),
      evidence: store.loadEvidence(),
      query: input.query,
      ...(kind !== undefined ? { kind } : {}),
    });
  } finally {
    store.close();
  }
}

/** semctx_verify_change: analyse a diff (given, or the current git diff). */
export function verifyChangeTool(root: string, input: { gitDiff?: string }): VerifyResult {
  const store = ensureReady(root);
  try {
    const config = loadConfig(root);
    const diffText =
      input.gitDiff !== undefined && input.gitDiff.trim().length > 0 ? input.gitDiff : currentGitDiff(root);
    return analyzeDiff({ index: new GraphIndex(store.loadGraph()), claims: store.loadClaims(), config, diffText });
  } finally {
    store.close();
  }
}

function normalizeKind(kind: string | undefined): InspectKind | undefined {
  const valid: InspectKind[] = ["symbol", "capability", "invariant", "contract", "test", "document", "any"];
  return kind !== undefined && valid.includes(kind as InspectKind) ? (kind as InspectKind) : undefined;
}

function currentGitDiff(root: string): string {
  const proc = Bun.spawnSync(["git", "diff", "HEAD", "--relative", "--unified=0", "--no-color"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  return proc.exitCode === 0 ? new TextDecoder().decode(proc.stdout) : "";
}
