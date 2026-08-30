#!/usr/bin/env node
// Semctx shadow lifecycle observer for Codex and Claude Code (GitHub issue #28).
//
// Automates exactly ONE checkpoint of AGENT_LIFECYCLE_POLICY_V1 — `before_completion` — and nothing
// else. It observes which Semctx MCP tools the host actually invoked during the session, keeps only
// canonical AgentWorkflowStageIdV1 identifiers in a session-local ledger, and reports the checkpoint
// when the host signals the end of an agent turn.
//
// Hard invariants:
//   * Non-blocking. Every path exits 0 — including an unexpected throw, which Node would otherwise
//     turn into exit 1. `process.exit` is never called, so the advisory is never truncated on a host
//     whose stderr pipe is asynchronous. Nothing is ever written to stdout, so neither host can parse
//     a decision, a permission verdict or an authorization out of this hook.
//   * Source-non-collecting. The host envelope is parsed and exactly four of its fields are used:
//     hook_event_name, session_id, cwd and tool_name. Every other field the host sends — prompt,
//     transcript_path, tool_input, tool_response, model, permission mode — is not retained, used or
//     reproduced; the transcript file is never opened and repository content is never read.
//     The ledger holds stage enums and nothing else; the session identity survives only as a
//     SHA-256 digest in a file name.
//   * No authority. The report fixes enforcementMode `shadow`, blockingEnabled `false` and
//     executionAuthority `none`, exactly like `semctx_control_agent_lifecycle`.
//   * No-op outside a Semctx repository: nothing is read, written or printed.
//   * Silent on an empty observation. A session in which no Semctx tool was observed produces no
//     advisory at all — a host that does not deliver tool events must never be reported as an agent
//     that skipped its completion stages.
//   * Speaks only on change. The ledger spans the session while the host ends a turn many times, so
//     the advisory is emitted only when the observed stage set has changed since the last one. A
//     completed cycle therefore never re-reports `RECORDED` over later turns that produced no
//     evidence, and an unchanged `INCOMPLETE` does not repeat every turn.
//
// The other three checkpoints stay manual. `before_implementation_write` needs the task altitude,
// `after_repository_edits` needs observed touched coordinates, and `before_compaction` needs the
// Handoff v2 payload — none of which a host hook envelope carries.
//
// The policy is NOT restated here. `semctx-lifecycle-contract.json`, next to this file, is generated
// from AGENT_WORKFLOW_CONTRACT_V1 and AGENT_LIFECYCLE_POLICY_V1 by scripts/build-plugin-runtime.ts,
// and `bun run plugin:check` fails on drift.
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Generated policy projection, resolved next to this file. */
export const CONTRACT_FILE_NAME = "semctx-lifecycle-contract.json";
/** Ledger location inside the repository's git-ignored agent scratch (`.gitignore` has `.semctx/*`). */
export const LEDGER_RELATIVE_DIR = [".semctx", "working", "agent-lifecycle"];
/**
 * A ledger only ever holds up to `maxRecordedStageIds` observations plus one report watermark per
 * distinct observed set — both bounded by the 15 canonical stages. Anything larger is corruption.
 */
export const MAX_LEDGER_BYTES = 32 * 1024;
/** Hard cap on retained session ledgers. Sessions cannot prove their own death, so the oldest go. */
export const MAX_LEDGER_FILES = 64;
/** Domain separator for the ledger file name. Keeps the digest unusable as a session oracle. */
export const LEDGER_KEY_DOMAIN = "semctx.agent-lifecycle-ledger.v1\0";
/** Host event that reports one completed tool call. */
export const OBSERVE_EVENT = "PostToolUse";
/** Host event that ends an agent turn — where `before_completion` is evaluated. */
export const REPORT_EVENT = "Stop";

const LEDGER_FILE_PATTERN = /^[0-9a-f]{64}\.ndjson$/;

/**
 * Enablement: `SEMCTX_LIFECYCLE=off` strictly disables the observer. The surface is advisory and
 * cannot block, so it is on by default — but local enforcement, advisory included, stays
 * disableable without deleting `hooks/hooks.json` and losing the unrelated commit/push guard.
 */
export function lifecycleEnabled(env = process.env) {
  const value = String(env?.SEMCTX_LIFECYCLE ?? "").toLowerCase();
  return value !== "off" && value !== "0" && value !== "false";
}

/** Structural guard at the file boundary: a hand-edited or stale contract must never throw. */
export function isHookContract(value) {
  if (value === null || typeof value !== "object") return false;
  if (value.schemaVersion !== 1 || value.kind !== "agent_lifecycle_hook_contract") return false;
  if (value.checkpoint !== "before_completion") return false;
  if (typeof value.reportDomain !== "string" || value.reportDomain.length === 0) return false;
  if (!Number.isInteger(value.requiredAltitude)) return false;
  if (!isStringArray(value.stageOrder) || value.stageOrder.length === 0) return false;
  if (typeof value.profileStageId !== "string") return false;
  if (value.requiredStageIds === null || typeof value.requiredStageIds !== "object") return false;
  if (!isStringArray(value.requiredStageIds.implementation)) return false;
  if (!isStringArray(value.requiredStageIds.migration)) return false;
  if (value.toolStages === null || typeof value.toolStages !== "object") return false;
  if (value.policy === null || typeof value.policy !== "object") return false;
  if (typeof value.policy.accumulationSemantics !== "string") return false;
  if (!Number.isInteger(value.policy.maxRecordedStageIds)) return false;
  return true;
}

/** Load the generated contract, or null when it is absent, unreadable or malformed. */
export function loadHookContract(directory = dirname(fileURLToPath(import.meta.url))) {
  try {
    const parsed = JSON.parse(readFileSync(join(directory, CONTRACT_FILE_NAME), "utf8"));
    return isHookContract(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Normalize a Codex or Claude Code envelope. Both hosts send the same JSON object on stdin and both
 * carry `hook_event_name`, `session_id` and `cwd`; tool events add `tool_name`. Every other field is
 * ignored on purpose — that is what keeps the hook source-non-collecting.
 */
export function normalizeHookEnvelope(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const event = nonEmptyString(input.hook_event_name ?? input.hookEventName);
  if (event === null) return null;
  return {
    event,
    sessionId: nonEmptyString(input.session_id ?? input.sessionId),
    cwd: nonEmptyString(input.cwd),
    toolName: nonEmptyString(input.tool_name ?? input.toolName),
  };
}

/**
 * Reduce a host tool name to the canonical Semctx MCP tool it invoked, or null.
 * Both shipped plugin manifests register the bundled server as `semctx`, so only that exact MCP
 * namespace is eligible. Accepting a matching trailing token from an arbitrary server would let a
 * different MCP server manufacture Semctx lifecycle evidence.
 */
export function canonicalSemctxTool(contract, toolName) {
  if (typeof toolName !== "string" || toolName.length === 0) return null;
  const prefix = "mcp__semctx__";
  if (!toolName.startsWith(prefix)) return null;
  const canonical = toolName.slice(prefix.length);
  return Object.hasOwn(contract.toolStages, canonical) ? canonical : null;
}

/** Canonical stage id for an observed host tool name, or null when the tool is not a lifecycle tool. */
export function stageForToolName(contract, toolName) {
  const canonical = canonicalSemctxTool(contract, toolName);
  if (canonical === null) return null;
  const stage = contract.toolStages[canonical];
  return contract.stageOrder.includes(stage) ? stage : null;
}

/**
 * Classify the repository exactly as the runtime does for `non_semctx`, and never further: this hook
 * does not open the Semctx store, so it never asserts `semctx_ready`. Everything that is not
 * `non_semctx` is reported `semctx_unready` — readiness stays a runtime verdict, and the fail-closed
 * direction is the only honest one for an observer that did not check.
 */
export function hookRepositoryState(root) {
  const configuration = pathKind(join(root, ".semctx", "config.json"));
  const semantic = pathKind(join(root, ".semctx", "semantic"));
  if (configuration === "missing" && semantic !== "directory") return "non_semctx";
  return "semctx_unready";
}

/**
 * The repository the host is working in, or null.
 *
 * This is `cwd` itself and never an ancestor. The runtime binds a repository root explicitly
 * (`SEMCTX_ROOT` / the first absolute `repositoryRoot` argument) and `canonicalDirectory` never walks
 * up, so neither may this hook: an ancestor walk from a scratch directory happily binds to an
 * unrelated `.semctx` further up — a home directory, for one — and writes another repository's
 * ledger. A cwd below the repository root is a silent no-op, which is the safe direction.
 *
 * `cwd` arrives on untrusted stdin, so a relative, missing, or non-directory path resolves to null.
 * A relative path is refused rather than resolved: `resolve()` would silently anchor it to the hook
 * process's own working directory, which is not the host's repository and is not knowable here.
 */
export function resolveRepositoryRoot(cwd) {
  if (typeof cwd !== "string" || cwd.length === 0 || !isAbsolute(cwd)) return null;
  try {
    const root = resolve(cwd);
    return lstatSync(root).isDirectory() ? root : null;
  } catch {
    return null;
  }
}

/** Opaque per-session, per-repository ledger identity. The session id never reaches the disk. */
export function ledgerKey(sessionId, repositoryRoot) {
  return createHash("sha256")
    .update(LEDGER_KEY_DOMAIN, "utf8")
    .update(`${sessionId}\0${repositoryRoot}`, "utf8")
    .digest("hex");
}

/** Absolute ledger path for a session, under the repository's git-ignored agent scratch. */
export function ledgerPath(repositoryRoot, key) {
  return join(repositoryRoot, ...LEDGER_RELATIVE_DIR, `${key}.ndjson`);
}

/**
 * Read an append-only stage ledger. Two record shapes are legal and both carry canonical stage ids
 * and nothing else: an observation (`stageId`) and a report watermark (`reportedStageIds`), which
 * records the set the last advisory spoke about.
 *
 * A torn final record — the tail of a write that raced this read — is dropped, exactly as the
 * anchor-migration journal does; any other unparseable or unknown record makes the whole ledger
 * `invalid`, because silently skipping it would let corruption read as a shorter, greener session.
 */
export function readLedger(contract, path) {
  let raw;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return invalidLedger();
    if (stat.size > MAX_LEDGER_BYTES) return invalidLedger();
    raw = readFileSync(path, "utf8");
  } catch {
    return { state: "missing", stageIds: [], reportedStageIds: null };
  }
  const lines = raw.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] !== "") lines.pop(); // torn tail
  const observed = new Set();
  let reportedStageIds = null;
  for (const line of lines) {
    if (line === "") continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return invalidLedger();
    }
    if (record === null || typeof record !== "object" || record.schemaVersion !== 1) {
      return invalidLedger();
    }
    if (typeof record.stageId === "string") {
      if (!contract.stageOrder.includes(record.stageId)) return invalidLedger();
      observed.add(record.stageId);
      continue;
    }
    if (Array.isArray(record.reportedStageIds)) {
      if (record.reportedStageIds.some((stage) => !contract.stageOrder.includes(stage))) {
        return invalidLedger();
      }
      reportedStageIds = canonicalStageIds(contract, record.reportedStageIds);
      continue;
    }
    return invalidLedger();
  }
  // A non-empty file that yielded no record at all is garbage, not a torn first write: dropping the
  // unterminated tail must not turn a whole file of junk into an empty-but-valid ledger that the
  // observer would then happily append to.
  if (observed.size === 0 && reportedStageIds === null && raw.trim() !== "") return invalidLedger();
  return { state: "valid", stageIds: canonicalStageIds(contract, observed), reportedStageIds };
}

/** Deduplicate and order stage ids exactly as the control model canonicalizes a recorded set. */
export function canonicalStageIds(contract, stageIds) {
  const present = stageIds instanceof Set ? stageIds : new Set(stageIds);
  return contract.stageOrder.filter((stage) => present.has(stage));
}

/**
 * Append one observed stage. Concurrent tool events in the same session race here, so records are
 * appended and deduplicated on read rather than read-modify-written — a rewrite would drop whichever
 * observation lost the race.
 */
export function appendObservedStage(repositoryRoot, path, stageId) {
  appendLedgerRecord(repositoryRoot, path, { schemaVersion: 1, stageId });
}

/**
 * Record the set the advisory just spoke about. The next end of turn compares against it and stays
 * silent while nothing new was observed, so one completed cycle cannot keep reporting `RECORDED`
 * over later turns that produced no evidence at all.
 */
export function appendReportWatermark(repositoryRoot, path, reportedStageIds) {
  appendLedgerRecord(repositoryRoot, path, {
    schemaVersion: 1,
    reportedStageIds: [...reportedStageIds],
  });
}

function appendLedgerRecord(repositoryRoot, path, record) {
  ensureLedgerDirectory(repositoryRoot);
  const payload = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  const handle = openSync(path, "a", 0o600);
  try {
    let written = 0;
    while (written < payload.byteLength) {
      written += writeSync(handle, payload, written, payload.byteLength - written);
    }
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

/**
 * Keep the ledger directory bounded. A session cannot prove its own death — the hook is a short
 * lived process whose pid is not the session's — so retention is a cap, not an expiry, and the
 * ledger being written is never a candidate.
 */
export function pruneLedgerDirectory(directory, keepFileName, limit = MAX_LEDGER_FILES) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !LEDGER_FILE_PATTERN.test(entry.name)) continue;
    if (entry.name === keepFileName) continue;
    try {
      candidates.push({ name: entry.name, mtimeMs: statSync(join(directory, entry.name)).mtimeMs });
    } catch {
      // unreadable entry: leave it alone rather than guess its age
    }
  }
  const retained = Math.max(0, limit - 1); // the kept ledger occupies one slot
  if (candidates.length <= retained) return [];
  candidates.sort((left, right) =>
    left.mtimeMs - right.mtimeMs || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const removed = [];
  for (const candidate of candidates.slice(0, candidates.length - retained)) {
    try {
      rmSync(join(directory, candidate.name), { force: true });
      removed.push(candidate.name);
    } catch {
      // a ledger another process holds open stays; the cap is best-effort, never load-bearing
    }
  }
  return removed;
}

/** Stable JSON for the report preimage: object keys sorted recursively, array order preserved. */
export function serializeCanonicalReport(value) {
  return JSON.stringify(canonicalizeValue(value));
}

/** `reportHash` over the domain-separated canonical preimage, byte-for-byte as the control model. */
export function computeReportHash(domain, preimage) {
  return `sha256:${createHash("sha256")
    .update(Buffer.from(domain, "utf8"))
    .update(Buffer.from(serializeCanonicalReport(preimage), "utf8"))
    .digest("hex")}`;
}

/**
 * Evaluate `before_completion` from observed stages alone.
 *
 * `profile` is observed, not assumed: `target_propose` carries the canonical `migration_task`
 * condition, so its presence is the only migration evidence a tool observer can hold. `requiredAltitude`
 * is the checkpoint's own floor rather than a claim about the task — this checkpoint's decision is
 * altitude-invariant, which the test suite proves against the control model for every altitude.
 */
export function evaluateBeforeCompletion(contract, { repositoryState, recordedStageIds }) {
  const recorded = canonicalStageIds(contract, recordedStageIds);
  const profile = recorded.includes(contract.profileStageId) ? "migration" : "implementation";
  const nonSemctx = repositoryState === "non_semctx";
  const requiredStageIds = nonSemctx ? [] : contract.requiredStageIds[profile];
  const present = new Set(recorded);
  const missingStageIds = requiredStageIds.filter((stage) => !present.has(stage));
  const reasonCodes = [];
  if (nonSemctx) reasonCodes.push("NON_SEMCTX_REPOSITORY");
  if (!nonSemctx && repositoryState === "semctx_unready") reasonCodes.push("SEMCTX_REPOSITORY_UNREADY");
  if (!nonSemctx && missingStageIds.length > 0) reasonCodes.push("REQUIRED_STAGE_NOT_RECORDED");
  const preimage = {
    schemaVersion: 1,
    kind: "agent_lifecycle_report",
    checkpoint: contract.checkpoint,
    profile,
    requiredAltitude: contract.requiredAltitude,
    applicability: nonSemctx ? "not_applicable" : "eligible",
    repositoryState,
    stagePresenceVerdict: nonSemctx ? "NO_OP" : missingStageIds.length > 0 ? "INCOMPLETE" : "RECORDED",
    stageOutcomesEvaluated: false,
    admissibility: "not_evaluated",
    reasonCodes,
    requiredStageIds,
    recordedStageIds: nonSemctx ? [] : recorded,
    missingStageIds,
    accumulatedTouchedCoordinateIds: [],
    touchEvidence: "caller_observed_advisory",
    accumulationSemantics: contract.policy.accumulationSemantics,
    enforcementMode: "shadow",
    blockingEnabled: false,
    executionAuthority: "none",
    sourceContentCollected: false,
  };
  return { ...preimage, reportHash: computeReportHash(contract.reportDomain, preimage) };
}

/**
 * Human advisory lines. Deterministic and identical on both hosts: the report is the only input, and
 * no line carries an authorization, a block, or a completion claim.
 */
export function formatLifecycleAdvisory(report) {
  const lines = [
    `semctx shadow lifecycle - ${report.checkpoint}: ${report.stagePresenceVerdict}`,
  ];
  if (report.missingStageIds.length > 0) {
    lines.push(`  missing stages: ${report.missingStageIds.join(", ")}`);
  }
  lines.push(`  recorded stages: ${report.recordedStageIds.join(", ") || "none"}`);
  lines.push(`  reason codes: ${report.reasonCodes.join(", ") || "none"}`);
  lines.push(
    `  profile: ${report.profile} (observed)`
      + ` - requiredAltitude: L${report.requiredAltitude} (checkpoint floor, not a task claim)`,
  );
  lines.push(
    `  repositoryState: ${report.repositoryState}`
      + " (this hook never starts the Semctx runtime, so it never asserts semctx_ready)",
  );
  lines.push(
    "  stage presence only: outcomes are not evaluated, admissibility is not evaluated,"
      + " enforcement is shadow, blocking is disabled, execution authority is none",
  );
  lines.push(`  reportHash: ${report.reportHash}`);
  return lines;
}

function canonicalizeValue(value) {
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, nested]) => [key, canonicalizeValue(nested)]),
    );
  }
  return value;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The runtime rethrows anything that is not `ENOENT` here; this hook cannot, because a throw it
 * cannot classify must still end as a silent success. An unreadable path therefore reads as
 * `missing`, which classifies the repository `non_semctx` and makes the hook a total no-op — the
 * safe direction for an observer that could not look.
 */
function pathKind(path) {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() ? "directory" : "other";
  } catch {
    return "missing";
  }
}

/**
 * Create the ledger directory one component at a time, refusing a symlink or a non-directory at
 * every level and re-checking containment inside the repository after each one. Short-circuiting on
 * the leaf would accept a symlinked `.semctx/working` and write the ledger outside the repository.
 * A concurrent first observation loses the `mkdir` race rather than the observation: `EEXIST` is the
 * other process having created the very directory this one wanted.
 */
function ensureLedgerDirectory(repositoryRoot) {
  const canonicalRoot = realpathSync.native(repositoryRoot);
  let current = repositoryRoot;
  for (const segment of LEDGER_RELATIVE_DIR) {
    current = join(current, segment);
    try {
      mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("unsafe lifecycle ledger directory");
    }
    const resolved = relative(canonicalRoot, realpathSync.native(current));
    if (resolved === "" || resolved.startsWith("..") || isAbsolute(resolved)) {
      throw new Error("lifecycle ledger directory escapes the repository");
    }
  }
  return current;
}

function observe(contract, envelope, root) {
  const stageId = stageForToolName(contract, envelope.toolName);
  if (stageId === null) return; // not a lifecycle tool: nothing observed, nothing written
  const key = ledgerKey(envelope.sessionId, root);
  const path = ledgerPath(root, key);
  const ledger = readLedger(contract, path);
  if (ledger.state === "valid" && ledger.stageIds.includes(stageId)) return;
  if (ledger.state === "invalid") return; // corruption is never repaired by appending to it
  appendObservedStage(root, path, stageId);
  pruneLedgerDirectory(join(root, ...LEDGER_RELATIVE_DIR), `${key}.ndjson`);
}

function report(contract, envelope, root, repositoryState) {
  const path = ledgerPath(root, ledgerKey(envelope.sessionId, root));
  const ledger = readLedger(contract, path);
  // Silence is the honest answer when nothing was observed: a host that delivers no tool events must
  // never be reported as an agent that skipped its completion stages.
  if (ledger.state !== "valid" || ledger.stageIds.length === 0) return;
  // The ledger spans the session but the host ends a turn many times. Speaking only when the observed
  // set has changed keeps a completed cycle from re-reporting `RECORDED` over later turns that
  // produced no evidence, and keeps an unchanged `INCOMPLETE` from repeating every turn.
  if (ledger.reportedStageIds !== null && sameStages(ledger.stageIds, ledger.reportedStageIds)) return;
  const evaluated = evaluateBeforeCompletion(contract, {
    repositoryState,
    recordedStageIds: ledger.stageIds,
  });
  appendReportWatermark(root, path, ledger.stageIds);
  process.stderr.write(`${formatLifecycleAdvisory(evaluated).join("\n")}\n`);
}

function sameStages(left, right) {
  return left.length === right.length && left.every((stage, index) => stage === right[index]);
}

function invalidLedger() {
  return { state: "invalid", stageIds: [], reportedStageIds: null };
}

/**
 * Never calls `process.exit`. Node writes stderr asynchronously to a pipe on macOS, so exiting right
 * after the advisory truncates it there; returning instead lets the stream flush and leaves the exit
 * code at its default success. `process.exitCode` is pinned and never reassigned, and the two global
 * handlers keep an unexpected throw or rejection from turning into a failing exit code.
 */
function main() {
  process.exitCode = 0;
  process.on("uncaughtException", () => {
    process.exitCode = 0;
  });
  process.on("unhandledRejection", () => {
    process.exitCode = 0;
  });
  try {
    if (!lifecycleEnabled(process.env)) return;
    let input;
    try {
      input = JSON.parse(readFileSync(0, "utf8"));
    } catch {
      return;
    }
    const envelope = normalizeHookEnvelope(input);
    if (envelope === null) return;
    if (envelope.event !== OBSERVE_EVENT && envelope.event !== REPORT_EVENT) return;
    // Without a session identity the ledger cannot be isolated, and a shared ledger would let one
    // session's tool calls satisfy another session's checkpoint.
    if (envelope.sessionId === null) return;
    const contract = loadHookContract();
    if (contract === null) return;
    const root = resolveRepositoryRoot(envelope.cwd);
    if (root === null) return;
    const repositoryState = hookRepositoryState(root);
    if (repositoryState === "non_semctx") return; // no read, no write, no output
    if (envelope.event === OBSERVE_EVENT) observe(contract, envelope, root);
    else report(contract, envelope, root, repositoryState);
  } catch {
    // Advisory only: an unexpected failure is a silent no-op, never a blocked host.
  }
}

if (process.argv[1]?.endsWith("semctx-lifecycle.mjs")) main();
