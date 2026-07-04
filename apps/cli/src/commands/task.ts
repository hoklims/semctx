import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SemctxError, TaskFrameInputSchema, TaskModeSchema } from "@semantic-context/core";
import type { TaskFrameInput, TaskMode } from "@semantic-context/core";
import { openStore } from "@semantic-context/repository-store";
import { parseTaskDocument, defaultTaskExtractor, extractionContext } from "@semantic-context/context-engine";
import type { ParsedArgs } from "../args";
import { flagString, flagBool } from "../args";
import { info, success, heading, json, c, warn, nowIso } from "../output";

function readInput(args: ParsedArgs): TaskFrameInput {
  const fromFile = flagString(args, "from-file");
  const text = flagString(args, "text");

  if (fromFile !== undefined) {
    const path = resolve(process.cwd(), fromFile);
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (cause) {
      throw new SemctxError("IO_ERROR", `cannot read task file ${path}`, { cause: String(cause) });
    }
    if (fromFile.endsWith(".json")) {
      const parsed = TaskFrameInputSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        throw new SemctxError("INVALID_TASK_INPUT", "task JSON failed schema validation", { issues: parsed.error.issues });
      }
      return parsed.data;
    }
    return parseTaskDocument(raw);
  }

  if (text !== undefined) return { rawTask: text };

  throw new SemctxError("INVALID_TASK_INPUT", 'provide --from-file <path> or --text "..."');
}

/** `semctx task create` — turn a task description into a persisted TaskFrame. */
export function runTaskCreate(root: string, args: ParsedArgs): number {
  let input = readInput(args);

  const modeOverride = flagString(args, "mode");
  if (modeOverride !== undefined) {
    const parsed = TaskModeSchema.safeParse(modeOverride);
    if (parsed.success) input = { ...input, mode: parsed.data as TaskMode };
    else warn(`ignoring invalid --mode "${modeOverride}"`);
  }

  const store = openStore(root);
  const graph = store.loadGraph();
  if (graph.nodes.length === 0) warn("repository not indexed; run 'semctx index' first for capability/invariant matching");
  const taskFrame = defaultTaskExtractor.extract(input, extractionContext(graph, nowIso()));
  store.saveTaskFrame(taskFrame);
  store.close();

  if (flagBool(args, "json")) {
    json(taskFrame);
    return 0;
  }

  success(`created task ${c.bold(taskFrame.id)} (mode=${taskFrame.mode})`);
  heading("Resolved frame");
  info(`  capabilities   : ${taskFrame.capabilities.join(", ") || c.dim("none")}`);
  info(`  invariants     : ${taskFrame.hardInvariants.join(", ") || c.dim("none")}`);
  info(`  bounded ctx    : ${taskFrame.boundedContexts.join(", ") || c.dim("none")}`);
  info(`  hypotheses     : ${taskFrame.hypotheses.length}`);
  info("");
  info(c.dim(`Next: semctx context prepare ${taskFrame.id}`));
  return 0;
}
