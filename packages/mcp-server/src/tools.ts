import { TaskModeSchema } from "@semantic-context/core";
import type { TaskFrame, ContextPack, TaskFrameInput, TaskMode } from "@semantic-context/core";
import { loadConfig, openStore } from "@semantic-context/repository-store";
import type { ReadonlyRepositoryStore, SqliteRepositoryStore } from "@semantic-context/repository-store";
import { openReadyRepository, runVerify } from "@semantic-context/app-services";
import type { VerifyReport } from "@semantic-context/core";
import {
  extractionContext,
  defaultTaskExtractor,
  prepareContextPack,
  fetchProviderCandidates,
  inspectGraph,
  type InspectionResult,
  type InspectKind,
} from "@semantic-context/context-engine";

export function nowIso(): string {
  return new Date().toISOString();
}

/** Open an explicitly prepared repository without mutating readiness state. */
export function ensureReady(root: string): ReadonlyRepositoryStore {
  return openReadyRepository(root);
}

function openReadyWriter(root: string): SqliteRepositoryStore {
  const reader = openReadyRepository(root);
  reader.close();
  return openStore(root);
}

export interface PrepareTaskResult {
  taskFrame: TaskFrame;
  contextPack: ContextPack;
}

/** semctx_prepare_task: raw task -> TaskFrame + ContextPack. */
export async function prepareTaskTool(root: string, input: { task: string; mode?: string }): Promise<PrepareTaskResult> {
  const store = openReadyWriter(root);
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
export function verifyChangeTool(root: string, input: { gitDiff?: string }): VerifyReport {
  const source = input.gitDiff !== undefined && input.gitDiff.trim().length > 0
    ? { kind: "provided" as const, diffText: input.gitDiff }
    : { kind: "working-tree" as const };
  return runVerify(root, source).report;
}

function normalizeKind(kind: string | undefined): InspectKind | undefined {
  const valid: InspectKind[] = ["symbol", "capability", "invariant", "contract", "test", "document", "any"];
  return kind !== undefined && valid.includes(kind as InspectKind) ? (kind as InspectKind) : undefined;
}
