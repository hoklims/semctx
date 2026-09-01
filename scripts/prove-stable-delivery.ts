/**
 * Prove that a fresh Codex environment and a fresh Claude environment can install the plugins
 * published by the immutable commit promoted to `stable`.
 *
 * This closes the gap ADR 0014 names between the *observation* of five delivery states and the
 * *demonstration* that the channel actually delivers. `plugin-status` reports what a machine
 * already has; this proves that a machine with nothing can get it, from the release commit, and
 * that what it got executes.
 *
 * Six boundaries are load-bearing and deliberately not softened:
 *
 * - **Delivery is not activation.** A proven cache says what the *next* session resolves. No push,
 *   promotion or install refreshes a session that is already open, so `session.proven` is always
 *   `false` here and carries the exact activation action instead of a verdict.
 * - **Trust precedes effect.** Nothing is executed before it is attested. The CLI identities are
 *   proven, the witness is read from the *blobs of the published commit* rather than from a working
 *   tree, and every installed bundle is digested against it. Only a host that passed all of that
 *   has its CLI and MCP entrypoints started. An unattested payload is never run.
 * - **Absence is a failure, not a silence.** Every unknown appends a canonical reason and clears
 *   `ok`. There is no optimistic default.
 * - **A host is a hostile source of paths, and so is time.** Everything a host CLI *says* is
 *   admitted only after it is proven absolute, canonical, local, link-free and inside the isolated
 *   root — and re-admitted immediately before each use, because a path that was a directory when it
 *   was checked can be a junction when it is read.
 * - **The orchestrator never opens the user's real profiles.** Isolation is proven for its own
 *   accesses by construction and by the ledger of paths actually touched, not by reading
 *   `~/.codex` and `~/.claude` to see whether they changed. There is no syscall sandbox, so this is
 *   deliberately not a claim about every file a child process could open.
 * - **The archived bytes are the authority.** The workflow leaves a placeholder before this script
 *   can even be imported, the script overwrites it with the final proof, and the exit status is
 *   derived from re-reading what is actually on disk. A placeholder from this very run is never
 *   accepted as evidence.
 */

import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  codexCacheEntryFromMarketplaceRoot,
  PLUGIN_DELIVERY_RELEASE_REF,
  PLUGIN_RUNTIME_BUNDLES,
} from "@semantic-context/app-services";

export const STABLE_DELIVERY_PROOF_SCHEMA_VERSION = 2;
export const STABLE_DELIVERY_PROOF_KIND = "stable_delivery_proof";

export const MARKETPLACE_NAME = "semctx-stable";
export const CODEX_PLUGIN = "semctx-control";
export const CLAUDE_PLUGIN = "semctx";

/**
 * The split runtime both plugins ship, re-exported from the delivery authority rather than
 * redeclared: a second list here would drift from the one `plugin-status` already proves against.
 */
export { PLUGIN_RUNTIME_BUNDLES };

export type ProofHost = "codex" | "claude";

export const PROOF_HOSTS: readonly ProofHost[] = ["codex", "claude"];

/** The plugin id each host must resolve from the `semctx-stable` marketplace. */
export const EXPECTED_PLUGIN_ID: Record<ProofHost, string> = {
  codex: `${CODEX_PLUGIN}@${MARKETPLACE_NAME}`,
  claude: `${CLAUDE_PLUGIN}@${MARKETPLACE_NAME}`,
};

/**
 * The exact host CLIs this proof is defined against. Versioned *here*, in the repository, rather
 * than read from a mutable GitHub Actions variable: a proof whose only authority for "which Codex"
 * lives outside the commit cannot be replayed, and an unset variable would make the pin vacuous.
 * Ratified 2026-08-13; changing either specifier is a deliberate, reviewable commit.
 */
export const HOST_CLI_SPECIFICATION: Record<ProofHost, { package: string; version: string; specifier: string }> = {
  codex: { package: "@openai/codex", version: "0.147.0", specifier: "@openai/codex@0.147.0" },
  claude: {
    package: "@anthropic-ai/claude-code",
    version: "2.1.229",
    specifier: "@anthropic-ai/claude-code@2.1.229",
  },
};

/**
 * What a host operator must still do for a *running* session to pick up a delivered cache. Kept
 * verbatim from ADR 0014 so the proof proposes the same convergence path `semctx install` does.
 */
export const ACTIVATION_ACTION: Record<ProofHost, string> = {
  codex: "open a new Codex task; a running task keeps the version it started with",
  claude: "run /reload-plugins, or restart Claude Code",
};

export type ProofReason =
  | "RELEASE_IDENTITY_INCOMPLETE"
  | "RELEASE_TAG_VERSION_MISMATCH"
  | "RUN_IDENTITY_INCOMPLETE"
  | "PROOF_INPUT_INCOMPLETE"
  | "PROOF_NOT_COMPLETED"
  | "PROOF_ABORTED"
  | "PROOF_NOT_BOUND_TO_RUN"
  | "PROOF_PLACEHOLDER_NOT_REPLACED"
  | "PROOF_ARTIFACT_UNREADABLE"
  | "PROOF_ARCHIVE_MISMATCH"
  | "PREFLIGHT_FAILED"
  | "CHECKOUT_SHA_UNKNOWN"
  | "CHECKOUT_SHA_MISMATCH"
  | "WITNESS_NOT_FROM_COMMIT"
  | "WITNESS_INCOMPLETE"
  | "WITNESS_DIVERGED"
  | "HOST_ROOT_NOT_ISOLATED"
  | "HOST_ROOT_ESCAPED_SANDBOX"
  | "HOST_PATH_NOT_ABSOLUTE"
  | "HOST_PATH_ESCAPED_SANDBOX"
  | "HOST_PATH_IS_LINK"
  | "HOST_PATH_UNREADABLE"
  | "PROTECTED_ROOT_TOUCHED"
  | "LEDGER_PATH_ESCAPED"
  | "HOST_ENVIRONMENT_INCOMPLETE"
  | "HOST_CLI_UNAVAILABLE"
  | "HOST_CLI_QUERY_FAILED"
  | "HOST_CLI_UNRESOLVED"
  | "HOST_CLI_PACKAGE_ABSENT"
  | "HOST_CLI_VERSION_UNKNOWN"
  | "HOST_CLI_VERSION_MISMATCH"
  | "HOST_INSTALL_FAILED"
  | "MARKETPLACE_NOT_CONFIGURED"
  | "MARKETPLACE_ROOT_UNKNOWN"
  | "MARKETPLACE_SOURCE_MISMATCH"
  | "MARKETPLACE_REF_UNKNOWN"
  | "MARKETPLACE_REF_UNEXPECTED"
  | "MARKETPLACE_COMMIT_UNKNOWN"
  | "MARKETPLACE_COMMIT_MISMATCH"
  | "PLUGIN_NOT_RESOLVED"
  | "INSTALLED_VERSION_UNKNOWN"
  | "INSTALLED_VERSION_MISMATCH"
  | "MANIFEST_VERSION_UNKNOWN"
  | "MANIFEST_VERSION_MISMATCH"
  | "BUNDLE_SET_INCOMPLETE"
  | "BUNDLE_DIGEST_UNKNOWN"
  | "BUNDLE_DIGEST_MISMATCH"
  | "BUNDLE_NOT_ATTESTED"
  | "EXECUTION_SNAPSHOT_FAILED"
  | "HOST_ARTIFACTS_DIVERGED"
  | "CLI_SMOKE_NOT_RUN"
  | "CLI_SMOKE_FAILED"
  | "MCP_SMOKE_NOT_RUN"
  | "MCP_SMOKE_FAILED";

/** Why a running session's version stays unknown. Never upgraded by a proven cache. */
export const SESSION_UNKNOWN_REASON = "SESSION_VERSION_NOT_EXPOSED";

/**
 * The only two spellings of this repository a host may report, and the normalisation that maps
 * every official form onto them. Reproduced *verbatim* from `normalizeGitSource` /
 * `isSemctxSource` in `packages/app-services/src/plugin-delivery.ts`, which are module-private
 * there: a looser matcher of our own would accept `https://evil.example/hoklims/semctx.git`,
 * which merely contains the slug. The accepted/refused contract is pinned here by tests; the
 * duplicate implementation remains explicit maintenance debt until the shared helper is exported.
 */
export const MARKETPLACE_SOURCE_AUTHORITY: readonly string[] = [
  "hoklims/semctx",
  "https://github.com/hoklims/semctx",
];

/** The channel the marketplace must track, from the shared delivery authority. `main` is not one. */
export const RELEASE_REF = PLUGIN_DELIVERY_RELEASE_REF;

export interface ReleaseIdentity {
  /** The release commit. Every other identity in the proof is compared against it. */
  sha: string;
  /** The annotated tag that triggered the release, `v<version>`. */
  tag: string;
  /** The published version, `tag` without its leading `v`. */
  version: string;
}

/**
 * The workflow run that produced this artifact. Archived and re-checked so a proof cannot be
 * replayed from a different run: the release identity alone repeats across attempts of the
 * same tag, which is exactly when a stale artifact looks freshest.
 */
export interface RunIdentity {
  repository: string;
  runId: string;
  runAttempt: string;
  /** Exact commit whose proof implementation and dependencies produced the artifact. */
  verifierSha: string;
}

export interface SmokeOutcome {
  /** `false` means the smoke never executed — which is a failure, not a neutral state. */
  ran: boolean;
  ok: boolean;
  /** Command or capability exercised, for the archived artifact. */
  detail: string;
}

/**
 * One official install command as it actually ran. Archived whether it succeeded or not: a failed
 * install that names only `HOST_INSTALL_FAILED` cannot be diagnosed from the artifact alone, which
 * is exactly the gap the HOK-582 incident exposed. `stdout`/`stderr` are bounded so a chatty CLI
 * cannot bloat the artifact: it retains a fixed-length prefix plus a truncation note.
 */
export interface InstallAttempt {
  argv: readonly string[];
  code: number;
  stdout: string;
  stderr: string;
}

/** Where a path the proof consumed came from, and whether it was admitted. */
export interface PathAdmission {
  label: string;
  candidate: string | null;
  admitted: string | null;
  reason: ProofReason | null;
}

/** Which host CLI was asked for, which one answered, and what it calls itself. */
export interface HostCliObservation {
  requestedPackage: string;
  requestedSpecifier: string;
  expectedVersion: string;
  /** `name@version` npm actually resolved on the runner. `null` when it could not be read. */
  resolvedPackage: string | null;
  resolvedVersion: string | null;
  /** Whether the resolution query itself succeeded. A non-zero query is never a resolution. */
  resolutionQueryOk: boolean;
  /** Whether the pinned package appeared at all in a successful resolution. */
  packagePresent: boolean;
  /** `--version` as printed, kept verbatim for the artifact. */
  rawVersion: string | null;
  /** The semver token extracted from it, which is what the pin is compared against. */
  reportedVersion: string | null;
}

export interface HostObservation {
  host: ProofHost;
  /**
   * Whether the host's own CLI answered on this runner. An absent host is a failure, never a skip:
   * a proof that silently omits a host would report delivery it never exercised.
   */
  cliAvailable: boolean;
  /** Whether the confined environment can actually launch a process (a controlled `PATH`, mainly). */
  environmentUsable: boolean;
  /** Whether every official install command succeeded. */
  installSucceeded: boolean;
  /** Every official install command actually run, in order, with its argv, exit code and output. */
  installAttempts: InstallAttempt[];
  cli: HostCliObservation;
  /** The temporary root this host was confined to. `null` when it could not be established. */
  root: string | null;
  /** Whether the host is configured against the `semctx-stable` marketplace at the `stable` ref. */
  marketplaceConfigured: boolean;
  marketplaceSource: string | null;
  marketplaceRef: string | null;
  /** Marketplace snapshot root, as the host reports it and after admission. */
  marketplaceRoot: string | null;
  /** Commit the installed marketplace snapshot came from. `null` when the host did not expose it. */
  marketplaceCommit: string | null;
  /** Version the host itself reports for the resolved plugin. */
  reportedVersion: string | null;
  /** Whether the host reports the expected plugin id as installed and enabled. */
  pluginResolved: boolean;
  /** Version declared by the installed cache manifest — read from disk, not from the host. */
  manifestVersion: string | null;
  /** Absolute path of the versioned cache entry the host executes, after admission. */
  cachePath: string | null;
  /** Every host-supplied path this run considered, admitted or refused, admission and re-admission. */
  pathAdmissions: PathAdmission[];
  /** SHA-256 per runtime bundle basename; `null` for a bundle that could not be digested. */
  bundles: Record<string, string | null>;
  /** Whether every bundle matched the committed witness. Smokes run only when this is `true`. */
  attested: boolean;
  /** Whether building either execution copy from the attested bytes failed. */
  snapshotFailed?: boolean;
  /**
   * Separate orchestrator-owned directories used for the CLI and MCP smokes. Each is created from
   * the attested in-memory buffers immediately before its one consumer runs. They prevent the first
   * smoke from changing what the second smoke executes; they are not an OS security boundary against
   * another process already running as the same user.
   */
  executionSnapshots: { cli: string | null; mcp: string | null };
  cliSmoke: SmokeOutcome;
  mcpSmoke: SmokeOutcome;
}

/** One filesystem or process effect the run actually performed. */
export interface LedgerEntry {
  operation: "read" | "digest" | "exec" | "write" | "make" | "blob" | "stat";
  path: string;
}

export interface IsolationObservation {
  /** Absolute sandbox base every host root must live under. */
  sandboxRoot: string | null;
  /** Roots the run is allowed to touch at all. */
  allowedRoots: readonly string[];
  /**
   * Roots that must never appear in the ledger. Their *absence from the ledger* is the proof; they
   * are deliberately never opened, because reading a user profile to check it was not read is the
   * boundary crossing this proof forbids.
   */
  forbiddenRoots: readonly string[];
  /** Every path the run touched, in order. */
  ledger: readonly LedgerEntry[];
}

/** The checkout the witness is read from, and whether it really is the released commit. */
export interface CheckoutObservation {
  path: string;
  /** `GITHUB_SHA`. */
  expected: string;
  /** `git rev-parse HEAD`, or `null` when Git did not answer. */
  head: string | null;
}

export interface HostProof {
  host: ProofHost;
  pluginId: string;
  root: string | null;
  cli: HostCliObservation;
  installAttempts: InstallAttempt[];
  marketplaceRoot: string | null;
  marketplaceCommit: string | null;
  marketplaceRef: string | null;
  version: string | null;
  cachePath: string | null;
  pathAdmissions: PathAdmission[];
  bundles: Record<string, string | null>;
  attested: boolean;
  executionSnapshots: { cli: string | null; mcp: string | null };
  cliSmoke: SmokeOutcome;
  mcpSmoke: SmokeOutcome;
  /** Activation is its own dimension: delivery never implies a refreshed session. */
  activation: string;
  ok: boolean;
  reasons: ProofReason[];
}

export type ProofStage = "placeholder" | "final";

export interface StableDeliveryProof {
  schemaVersion: typeof STABLE_DELIVERY_PROOF_SCHEMA_VERSION;
  kind: typeof STABLE_DELIVERY_PROOF_KIND;
  /**
   * `placeholder` is written by the workflow before this script can be imported, so a provisioning,
   * import, syntax or startup failure still leaves valid JSON. Only `final` is evidence.
   */
  stage: ProofStage;
  ok: boolean;
  release: ReleaseIdentity;
  run: RunIdentity;
  checkout: CheckoutObservation & { ok: boolean };
  /** Bundle digests read from the *blobs of the published commit*, per plugin, archived separately. */
  witnesses: Record<ProofHost, Record<string, string | null>>;
  /** The digests both plugins agree on — the only witness a host is ever compared against. */
  witness: Record<string, string>;
  isolation: {
    ok: boolean;
    sandboxRoot: string | null;
    allowedRoots: readonly string[];
    forbiddenRoots: readonly string[];
    /** Homes, XDG roots, APPDATA and temp are replaced; only a system allow-list is inherited. */
    environmentConfinement: "imposed";
    /**
     * What the ledger covers, stated so the artifact cannot be read as more than it is: the
     * orchestrator's own reads, digests, writes, stats and spawn working directories. It does
     * **not** trace what Git, npm, a host CLI or the MCP server open once started.
     */
    observedScope: "orchestrator-direct-access-only";
    /** There is no OS- or syscall-level sandbox around the children this proof starts. */
    syscallSandbox: "none";
    orchestratorPaths: number;
    escaped: LedgerEntry[];
    reasons: ProofReason[];
  };
  hosts: Record<ProofHost, HostProof>;
  /** Never `true`: no supported host exposes what a running session loaded. */
  session: { proven: false; reason: typeof SESSION_UNKNOWN_REASON; activation: Record<ProofHost, string> };
  /** Free-text cause when the run aborted before it could observe anything. */
  detail: string | null;
  reasons: ProofReason[];
}

function isNonEmpty(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSha(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

// --- Host-supplied path admission ---------------------------------------------------------------

/** Bounds on anything a host hands back as a path. Refusal is cheaper than a deep traversal. */
const MAX_HOST_PATH_LENGTH = 4096;
const MAX_HOST_PATH_SEGMENTS = 64;

/** Windows device names remain devices in any directory, whatever extension is appended. */
const RESERVED_WINDOWS_SEGMENT = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** A plugin version becomes a path segment; anything that is not a semver token must never be one. */
const VERSION_SEGMENT =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * Compare paths the way the host filesystem does, and strip the Win32 extended-length prefix that
 * `realpath` may add — that prefix names the same file, so treating it as a difference would refuse
 * a legitimate deep path.
 */
function normalisePath(value: string, platform: NodeJS.Platform): string {
  if (platform !== "win32") return value.replace(/\/+$/, "");
  const withoutPrefix = value.replace(/^\\\\\?\\(UNC\\)?/, (_match, unc: string | undefined) =>
    unc === undefined ? "" : "\\\\");
  return withoutPrefix.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Path containment without touching the filesystem, so the check is deterministic in tests and
 * identical on both runners. Windows compares case-insensitively; a bare prefix match is rejected
 * because `/tmp/sandbox-evil` is not inside `/tmp/sandbox`.
 */
export function isWithinRoot(candidate: string, root: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!isNonEmpty(candidate) || !isNonEmpty(root)) return false;
  const normalisedCandidate = normalisePath(candidate, platform);
  const normalisedRoot = normalisePath(root, platform);
  if (normalisedCandidate === normalisedRoot) return true;
  return normalisedCandidate.startsWith(`${normalisedRoot}/`);
}

/**
 * Whether a host-supplied string is shaped like a local, absolute, canonical path. Purely lexical:
 * this half is what refuses a UNC share, a device path, a relative fragment or a traversal *before*
 * any filesystem call is made with it.
 */
export function isLocalCanonicalPath(candidate: string, platform: NodeJS.Platform): boolean {
  if (!isNonEmpty(candidate)) return false;
  if (candidate.length > MAX_HOST_PATH_LENGTH) return false;
  for (const character of candidate) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  // `\\server\share`, `//server/share`, `\\?\…` and `\\.\…` all leave the local, plain filesystem.
  if (/^[\\/]{2}/.test(candidate)) return false;
  const absolute = platform === "win32" ? /^[A-Za-z]:[\\/]/.test(candidate) : candidate.startsWith("/");
  if (!absolute) return false;
  const segments = candidate.split(platform === "win32" ? /[\\/]+/ : /\/+/).slice(1);
  if (segments.length > MAX_HOST_PATH_SEGMENTS) return false;
  for (const segment of segments) {
    if (segment.length === 0) continue; // A trailing separator is not a segment.
    if (segment === "." || segment === "..") return false;
    if (platform === "win32" && RESERVED_WINDOWS_SEGMENT.test(segment)) return false;
  }
  return true;
}

/**
 * Admit a path, or name why it is refused. Every host answer *and every descendant this proof
 * actually consumes* — manifest, each dist bundle, each executable, the marketplace metadata —
 * passes through here before it is read, digested, executed or handed to Git. The filesystem half
 * refuses a symlink, junction, reparse point or short-name alias below the isolated root by
 * requiring the path's resolved suffix to match its lexical suffix. The root's own resolved path is
 * the baseline because Windows runners may place their temporary directory below a system junction.
 */
export function admitHostPath(
  label: string,
  candidate: string | null | undefined,
  sandboxRoot: string | null,
  runtime: Pick<DeliveryProofRuntime, "realPath" | "pathKind">,
  platform: NodeJS.Platform,
): PathAdmission {
  const observed = isNonEmpty(candidate) ? candidate : null;
  const refuse = (reason: ProofReason): PathAdmission => ({ label, candidate: observed, admitted: null, reason });

  if (observed === null || !isLocalCanonicalPath(observed, platform)) return refuse("HOST_PATH_NOT_ABSOLUTE");
  if (!isNonEmpty(sandboxRoot) || !isWithinRoot(observed, sandboxRoot, platform)) {
    return refuse("HOST_PATH_ESCAPED_SANDBOX");
  }

  // The sandbox root is created by this proof, but its runner-owned ancestors may legitimately be
  // junctions (GitHub's Windows runner temp directory is one example). Reject a linked root itself,
  // then use its physical location as the baseline for every descendant.
  const sandboxKind = runtime.pathKind(sandboxRoot);
  if (sandboxKind === "link") return refuse("HOST_PATH_IS_LINK");
  if (sandboxKind !== "directory") return refuse("HOST_PATH_UNREADABLE");
  const realSandboxRoot = runtime.realPath(sandboxRoot);
  if (!isNonEmpty(realSandboxRoot)) return refuse("HOST_PATH_UNREADABLE");

  const kind = runtime.pathKind(observed);
  if (kind === "link") return refuse("HOST_PATH_IS_LINK");
  if (kind === "absent" || kind === "unreadable") return refuse("HOST_PATH_UNREADABLE");

  const real = runtime.realPath(observed);
  if (!isNonEmpty(real)) return refuse("HOST_PATH_UNREADABLE");
  const normalisedRoot = normalisePath(sandboxRoot, platform);
  const suffix = normalisePath(observed, platform).slice(normalisedRoot.length);
  const expectedReal = `${normalisePath(realSandboxRoot, platform)}${suffix}`;
  // A link or 8.3 alias at/below the sandbox changes the physical suffix. An alias above it changes
  // both real paths equally and is therefore an accepted property of the runner, not a host escape.
  if (normalisePath(real, platform) !== expectedReal) return refuse("HOST_PATH_IS_LINK");
  if (!isWithinRoot(real, realSandboxRoot, platform)) return refuse("HOST_PATH_ESCAPED_SANDBOX");

  // Preserve the lexical path for subsequent operations. Its physical target has been proven above,
  // but returning that physical spelling would make the next re-admission compare it against the
  // still-logical sandbox root and falsely report an escape under a runner-owned ancestor junction.
  return { label, candidate: observed, admitted: observed, reason: null };
}

/**
 * Admission is a fact about a moment, not a property of a path. Anything consumed is re-admitted
 * immediately before the operation, so a directory swapped for a junction between the check and the
 * read fails *before* the read rather than after it. Both admissions are archived.
 */
export class ConfinedAccess {
  constructor(
    private readonly runtime: DeliveryProofRuntime,
    private readonly sandboxRoot: string,
    private readonly admissions: PathAdmission[],
  ) {}

  admit(label: string, candidate: string | null | undefined): string | null {
    const admission = admitHostPath(label, candidate, this.sandboxRoot, this.runtime, this.runtime.platform);
    this.admissions.push(admission);
    return admission.admitted;
  }

  /**
   * Re-admit the anchor *and* the leaf. A junction dropped on the cache root redirects every
   * descendant without any leaf ever changing, so checking only the file about to be read would
   * miss the substitution that matters most.
   */
  private reAdmit(label: string, candidate: string | null, anchor: string | null, suffix: string): string | null {
    if (anchor !== null && this.admit(`${label}#anchor`, anchor) === null) return null;
    return this.admit(`${label}${suffix}`, candidate);
  }

  read(label: string, candidate: string | null, anchor: string | null = null): string | null {
    const path = this.reAdmit(label, candidate, anchor, "#use");
    return path === null ? null : this.runtime.readTextFile(path);
  }

  /**
   * Read a declaration that newer host releases may legitimately omit. The containing snapshot is
   * re-admitted before even asking whether the leaf exists: otherwise a swapped cache root could
   * redirect that apparently harmless existence check outside the sandbox. A missing leaf is an
   * archived observation, not a failed admission; every present leaf still follows the strict
   * admission path immediately before it is read.
   */
  readOptional(label: string, candidate: string | null, anchor: string): string | null {
    if (this.admit(`${label}#anchor`, anchor) === null) return null;
    if (candidate === null || !isLocalCanonicalPath(candidate, this.runtime.platform)
      || !isWithinRoot(candidate, this.sandboxRoot, this.runtime.platform)) {
      this.admit(`${label}#use`, candidate);
      return null;
    }
    if (this.runtime.pathKind(candidate) === "absent") {
      this.admissions.push({ label: `${label}#absent`, candidate, admitted: null, reason: null });
      return null;
    }
    const path = this.admit(`${label}#use`, candidate);
    if (path === null) return null;
    const contents = this.runtime.readTextFile(path);
    if (contents === null) {
      this.admissions.push({ label: `${label}#read`, candidate: path, admitted: null, reason: "HOST_PATH_UNREADABLE" });
    }
    return contents;
  }

  digest(label: string, candidate: string | null, anchor: string | null = null): string | null {
    const path = this.reAdmit(label, candidate, anchor, "#use");
    return path === null ? null : this.runtime.digestFile(path);
  }

  /**
   * Read the bytes once. The digest that attests them and the copy that will be executed are
   * taken from this single buffer, so no rewrite can land between the two — a second read of the
   * same path is exactly the window a path check cannot close.
   */
  bytes(label: string, candidate: string | null, anchor: string | null = null): Uint8Array | null {
    const path = this.reAdmit(label, candidate, anchor, "#use");
    return path === null ? null : this.runtime.readBytes(path);
  }

  /** Admit an executable immediately before spawning it. A refused entrypoint is never launched. */
  executable(label: string, candidate: string | null, anchor: string | null = null): string | null {
    return this.reAdmit(label, candidate, anchor, "#exec");
  }
}

// --- Evaluation ---------------------------------------------------------------------------------

/**
 * The exact expected bundle set, or the reason it is not. An extra file is tolerated by the host
 * layout, but a *missing* one is fatal: proving only the bundles that happen to be present is the
 * subset trap this check exists to close.
 */
function evaluateBundles(
  observed: Record<string, string | null>,
  witness: Record<string, string>,
): ProofReason[] {
  const reasons: ProofReason[] = [];
  for (const name of PLUGIN_RUNTIME_BUNDLES) {
    if (!(name in observed)) {
      reasons.push("BUNDLE_SET_INCOMPLETE");
      continue;
    }
    const digest = observed[name];
    if (!isNonEmpty(digest)) {
      reasons.push("BUNDLE_DIGEST_UNKNOWN");
      continue;
    }
    const expected = witness[name];
    if (!isNonEmpty(expected)) {
      reasons.push("WITNESS_INCOMPLETE");
      continue;
    }
    if (digest !== expected) reasons.push("BUNDLE_DIGEST_MISMATCH");
  }
  return reasons;
}

/** Whether every bundle matched the committed witness — the gate the smokes sit behind. */
export function bundlesAttested(
  observed: Record<string, string | null>,
  witness: Record<string, string>,
): boolean {
  return evaluateBundles(observed, witness).length === 0;
}

function evaluateSmoke(outcome: SmokeOutcome, notRun: ProofReason, failed: ProofReason): ProofReason[] {
  if (!outcome.ran) return [notRun];
  return outcome.ok ? [] : [failed];
}

/**
 * The provisioned CLI must be the pinned one, proven twice: npm's resolution of the requested
 * specifier, and what the binary on `PATH` calls itself. Either one alone can be satisfied by a
 * stale global install shadowing a fresh one. A resolution *query* that failed is not a resolution
 * at all, whatever it happened to print on stdout.
 */
export function evaluateCli(cli: HostCliObservation): ProofReason[] {
  const reasons: ProofReason[] = [];
  if (!cli.resolutionQueryOk) reasons.push("HOST_CLI_QUERY_FAILED");
  else if (!cli.packagePresent) reasons.push("HOST_CLI_PACKAGE_ABSENT");
  if (!isNonEmpty(cli.resolvedVersion)) reasons.push("HOST_CLI_UNRESOLVED");
  else if (cli.resolvedVersion !== cli.expectedVersion) reasons.push("HOST_CLI_VERSION_MISMATCH");
  if (!isNonEmpty(cli.reportedVersion)) reasons.push("HOST_CLI_VERSION_UNKNOWN");
  else if (cli.reportedVersion !== cli.expectedVersion) reasons.push("HOST_CLI_VERSION_MISMATCH");
  return reasons;
}

/** The identity gate: no host effect is authorised until its CLI is exactly the pinned one. */
export function cliIdentityProven(cli: HostCliObservation): boolean {
  return evaluateCli(cli).length === 0;
}

/** Reasons that must be empty before any installed payload is allowed to execute. */
export function evaluateExecutionAuthority(
  observation: HostObservation,
  release: ReleaseIdentity,
  witness: Record<string, string>,
  sandboxRoot: string | null,
  platform: NodeJS.Platform,
): ProofReason[] {
  const reasons: ProofReason[] = [];

  if (!observation.environmentUsable) reasons.push("HOST_ENVIRONMENT_INCOMPLETE");
  if (!observation.cliAvailable) reasons.push("HOST_CLI_UNAVAILABLE");
  if (!observation.installSucceeded) reasons.push("HOST_INSTALL_FAILED");
  reasons.push(...evaluateCli(observation.cli));

  if (!isNonEmpty(observation.root)) reasons.push("HOST_ROOT_NOT_ISOLATED");
  else if (!isNonEmpty(sandboxRoot) || !isWithinRoot(observation.root, sandboxRoot, platform)) {
    reasons.push("HOST_ROOT_ESCAPED_SANDBOX");
  }

  // A refused path is a failure of the run, not a detail of the artifact: it means the host pointed
  // the proof somewhere it was not allowed to look, or the target changed under it.
  for (const admission of observation.pathAdmissions) {
    if (admission.reason !== null) reasons.push(admission.reason);
  }

  if (!observation.marketplaceConfigured) reasons.push("MARKETPLACE_NOT_CONFIGURED");
  if (!isSemctxSource(observation.marketplaceSource)) reasons.push("MARKETPLACE_SOURCE_MISMATCH");
  // The channel is its own authority: a marketplace on the right repository but the wrong ref
  // delivers a different commit, and an absent ref is an unknown rather than a default.
  if (!isNonEmpty(observation.marketplaceRef)) reasons.push("MARKETPLACE_REF_UNKNOWN");
  else if (observation.marketplaceRef !== RELEASE_REF) reasons.push("MARKETPLACE_REF_UNEXPECTED");
  if (!isNonEmpty(observation.marketplaceRoot)) reasons.push("MARKETPLACE_ROOT_UNKNOWN");
  if (!isNonEmpty(observation.marketplaceCommit)) reasons.push("MARKETPLACE_COMMIT_UNKNOWN");
  else if (observation.marketplaceCommit !== release.sha) reasons.push("MARKETPLACE_COMMIT_MISMATCH");

  if (!observation.pluginResolved) reasons.push("PLUGIN_NOT_RESOLVED");

  if (!isNonEmpty(observation.reportedVersion)) reasons.push("INSTALLED_VERSION_UNKNOWN");
  else if (observation.reportedVersion !== release.version) reasons.push("INSTALLED_VERSION_MISMATCH");

  if (!isNonEmpty(observation.manifestVersion)) reasons.push("MANIFEST_VERSION_UNKNOWN");
  else if (observation.manifestVersion !== release.version) reasons.push("MANIFEST_VERSION_MISMATCH");

  reasons.push(...evaluateBundles(observation.bundles, witness));
  // Attestation is one member of the execution authority, so its failure is named separately from
  // the digest reason that caused it: "the smoke did not run" and "it was not allowed to run" are
  // different diagnoses.
  if (!observation.attested) reasons.push("BUNDLE_NOT_ATTESTED");

  return [...new Set(reasons)];
}

function evaluateHost(
  observation: HostObservation,
  release: ReleaseIdentity,
  witness: Record<string, string>,
  sandboxRoot: string | null,
  platform: NodeJS.Platform,
): HostProof {
  const reasons = evaluateExecutionAuthority(observation, release, witness, sandboxRoot, platform);
  if (observation.snapshotFailed === true) reasons.push("EXECUTION_SNAPSHOT_FAILED");
  reasons.push(...evaluateSmoke(observation.cliSmoke, "CLI_SMOKE_NOT_RUN", "CLI_SMOKE_FAILED"));
  reasons.push(...evaluateSmoke(observation.mcpSmoke, "MCP_SMOKE_NOT_RUN", "MCP_SMOKE_FAILED"));

  const unique = [...new Set(reasons)];
  return {
    host: observation.host,
    pluginId: EXPECTED_PLUGIN_ID[observation.host],
    root: observation.root,
    cli: observation.cli,
    installAttempts: observation.installAttempts,
    marketplaceRoot: observation.marketplaceRoot,
    marketplaceCommit: observation.marketplaceCommit,
    marketplaceRef: observation.marketplaceRef,
    version: observation.reportedVersion,
    cachePath: observation.cachePath,
    pathAdmissions: observation.pathAdmissions,
    bundles: observation.bundles,
    attested: observation.attested,
    executionSnapshots: observation.executionSnapshots,
    cliSmoke: observation.cliSmoke,
    mcpSmoke: observation.mcpSmoke,
    activation: ACTIVATION_ACTION[observation.host],
    ok: unique.length === 0,
    reasons: unique,
  };
}

/** Canonical Git-source normalisation, byte-for-byte the one the shared delivery layer applies. */
export function normaliseMarketplaceSource(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .trim()
    .toLowerCase()
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/, "$1")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
}

/**
 * Whether a host-reported marketplace source really is this repository. Exact equality against
 * the normalised authority, never containment: `attacker/hoklims/semctx` and
 * `https://evil.example/hoklims/semctx.git` both contain the slug and are both refused.
 */
export function isSemctxSource(source: string | null): boolean {
  return MARKETPLACE_SOURCE_AUTHORITY.includes(normaliseMarketplaceSource(source));
}

/**
 * Isolation as far as the orchestrator can observe it. Two mechanisms, stated separately because
 * they are not the same strength: the child environment is *imposed* (homes, XDG roots, APPDATA
 * and temp all replaced, only a system allow-list inherited), and every path this orchestrator
 * itself reads, digests, writes, stats or spawns from is recorded and bounded. The forbidden
 * roots are never opened — reading a user profile to prove it was not read would itself be the
 * crossing this check forbids — but their absence from the ledger is **not** proof that a child
 * never opened one: there is no syscall-level sandbox here, and Git, npm, a host CLI or the MCP
 * server can read whatever the OS lets them.
 */
function evaluateIsolation(
  isolation: IsolationObservation,
  platform: NodeJS.Platform,
): StableDeliveryProof["isolation"] {
  const reasons: ProofReason[] = [];
  const escaped: LedgerEntry[] = [];
  if (!isNonEmpty(isolation.sandboxRoot)) reasons.push("HOST_ROOT_NOT_ISOLATED");

  for (const entry of isolation.ledger) {
    if (isolation.forbiddenRoots.some((root) => isWithinRoot(entry.path, root, platform))) {
      escaped.push(entry);
      reasons.push("PROTECTED_ROOT_TOUCHED");
      continue;
    }
    if (!isolation.allowedRoots.some((root) => isWithinRoot(entry.path, root, platform))) {
      escaped.push(entry);
      reasons.push("LEDGER_PATH_ESCAPED");
    }
  }
  for (const forbidden of isolation.forbiddenRoots) {
    // A sandbox nested inside a forbidden root would make every containment check vacuous.
    if (isNonEmpty(isolation.sandboxRoot) && isWithinRoot(isolation.sandboxRoot, forbidden, platform)) {
      reasons.push("HOST_ROOT_ESCAPED_SANDBOX");
    }
  }

  const unique = [...new Set(reasons)];
  return {
    ok: unique.length === 0,
    sandboxRoot: isolation.sandboxRoot,
    allowedRoots: isolation.allowedRoots,
    forbiddenRoots: isolation.forbiddenRoots,
    environmentConfinement: "imposed",
    observedScope: "orchestrator-direct-access-only",
    syscallSandbox: "none",
    orchestratorPaths: isolation.ledger.length,
    escaped,
    reasons: unique,
  };
}

/** `v1.2.3` → `1.2.3`; anything else stays as-is so the mismatch is reported rather than repaired. */
export function versionFromTag(tag: string): string {
  return /^v\d/.test(tag) ? tag.slice(1) : tag;
}

function evaluateRelease(release: ReleaseIdentity): ProofReason[] {
  const reasons: ProofReason[] = [];
  if (!isNonEmpty(release.sha) || !isNonEmpty(release.tag) || !isNonEmpty(release.version)) {
    reasons.push("RELEASE_IDENTITY_INCOMPLETE");
    return reasons;
  }
  if (release.tag !== `v${release.version}`) reasons.push("RELEASE_TAG_VERSION_MISMATCH");
  return reasons;
}

function evaluateRun(run: RunIdentity): ProofReason[] {
  return isNonEmpty(run.repository)
    && isNonEmpty(run.runId)
    && isNonEmpty(run.runAttempt)
    && isSha(run.verifierSha)
    ? []
    : ["RUN_IDENTITY_INCOMPLETE"];
}

/**
 * The checkout the witness is read from must *be* the released commit. The workflow's checkout
 * behaviour is a convention, not evidence, so the head is read and compared explicitly.
 */
function evaluateCheckout(checkout: CheckoutObservation): ProofReason[] {
  if (!isNonEmpty(checkout.head)) return ["CHECKOUT_SHA_UNKNOWN"];
  if (!isNonEmpty(checkout.expected)) return ["RELEASE_IDENTITY_INCOMPLETE"];
  return checkout.head === checkout.expected ? [] : ["CHECKOUT_SHA_MISMATCH"];
}

/**
 * Reduce the two per-plugin witnesses to the digests they agree on. Reading one plugin's bundles
 * and applying them to both hosts would assert the cross-host identity this proof exists to
 * establish, so a bundle the two plugins disagree on licenses nobody.
 */
function evaluateWitnesses(
  witnesses: Record<ProofHost, Record<string, string | null>>,
): { agreed: Record<string, string>; reasons: ProofReason[] } {
  const reasons: ProofReason[] = [];
  const agreed: Record<string, string> = {};
  for (const name of PLUGIN_RUNTIME_BUNDLES) {
    const codex = witnesses.codex[name];
    const claude = witnesses.claude[name];
    if (!isNonEmpty(codex) || !isNonEmpty(claude)) {
      reasons.push("WITNESS_INCOMPLETE");
      continue;
    }
    if (codex !== claude) {
      reasons.push("WITNESS_DIVERGED");
      continue;
    }
    agreed[name] = codex;
  }
  return { agreed, reasons };
}

export interface DeliveryProofInput {
  release: ReleaseIdentity;
  run: RunIdentity;
  checkout: CheckoutObservation;
  witnesses: Record<ProofHost, Record<string, string | null>>;
  isolation: IsolationObservation;
  hosts: HostObservation[];
  platform?: NodeJS.Platform;
  detail?: string | null;
  extraReasons?: readonly ProofReason[];
}

/**
 * Compose the archived proof. Pure: every observation is supplied by the caller, so the same inputs
 * always yield the same verdict and each hostile scenario is a unit test rather than a live run.
 */
export function evaluateDeliveryProof(input: DeliveryProofInput): StableDeliveryProof {
  const platform = input.platform ?? process.platform;
  const reasons: ProofReason[] = [
    ...evaluateRelease(input.release),
    ...evaluateRun(input.run),
    ...evaluateCheckout(input.checkout),
    ...(input.extraReasons ?? []),
  ];

  const witness = evaluateWitnesses(input.witnesses);
  reasons.push(...witness.reasons);

  const isolation = evaluateIsolation(input.isolation, platform);
  reasons.push(...isolation.reasons);

  const hosts = {} as Record<ProofHost, HostProof>;
  for (const host of PROOF_HOSTS) {
    const observation = input.hosts.find((candidate) => candidate.host === host);
    if (observation === undefined) {
      hosts[host] = {
        host,
        pluginId: EXPECTED_PLUGIN_ID[host],
        root: null,
        cli: emptyCliObservation(host),
        installAttempts: [],
        marketplaceRoot: null,
        marketplaceCommit: null,
        marketplaceRef: null,
        version: null,
        cachePath: null,
        pathAdmissions: [],
        bundles: {},
        attested: false,
        executionSnapshots: { cli: null, mcp: null },
        cliSmoke: { ran: false, ok: false, detail: "host was never exercised" },
        mcpSmoke: { ran: false, ok: false, detail: "host was never exercised" },
        activation: ACTIVATION_ACTION[host],
        ok: false,
        reasons: ["PLUGIN_NOT_RESOLVED"],
      };
      reasons.push("PLUGIN_NOT_RESOLVED");
      continue;
    }
    const proof = evaluateHost(observation, input.release, witness.agreed, isolation.sandboxRoot, platform);
    hosts[host] = proof;
    reasons.push(...proof.reasons);
  }

  // Both plugins ship the same split runtime. Proving each against the witness separately and then
  // asserting their equality is what makes cross-host identity established rather than assumed.
  for (const name of PLUGIN_RUNTIME_BUNDLES) {
    const codex = hosts.codex.bundles[name];
    const claude = hosts.claude.bundles[name];
    if (isNonEmpty(codex) && isNonEmpty(claude) && codex !== claude) {
      reasons.push("HOST_ARTIFACTS_DIVERGED");
    }
  }

  const unique = [...new Set(reasons)];
  return {
    schemaVersion: STABLE_DELIVERY_PROOF_SCHEMA_VERSION,
    kind: STABLE_DELIVERY_PROOF_KIND,
    stage: "final",
    ok: unique.length === 0,
    release: input.release,
    run: input.run,
    checkout: { ...input.checkout, ok: evaluateCheckout(input.checkout).length === 0 },
    witnesses: input.witnesses,
    witness: witness.agreed,
    isolation,
    hosts,
    session: {
      proven: false,
      reason: SESSION_UNKNOWN_REASON,
      activation: { codex: ACTIVATION_ACTION.codex, claude: ACTIVATION_ACTION.claude },
    },
    detail: input.detail ?? null,
    reasons: unique,
  };
}

/**
 * Refuse an artifact that does not belong to the run consuming it. An archive from an earlier run
 * carries a real, internally consistent proof — which is exactly why identity has to be checked
 * against the *current* release and the *current* run rather than trusted from the file. Two
 * attempts of the same tag share a release identity, so the run identity is what separates them.
 */
export function proofBelongsToRun(
  proof: Pick<StableDeliveryProof, "schemaVersion" | "kind" | "release" | "run">,
  release: ReleaseIdentity,
  run: RunIdentity,
): boolean {
  return proof.schemaVersion === STABLE_DELIVERY_PROOF_SCHEMA_VERSION
    && proof.kind === STABLE_DELIVERY_PROOF_KIND
    && proof.release.sha === release.sha
    && proof.release.tag === release.tag
    && proof.release.version === release.version
    && proof.run.repository === run.repository
    && proof.run.runId === run.runId
    && proof.run.runAttempt === run.runAttempt
    && proof.run.verifierSha === run.verifierSha;
}

export function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface ReleaseEnvironment {
  GITHUB_SHA?: string | undefined;
  GITHUB_REF_NAME?: string | undefined;
}

/** Resolve the release identity from the workflow environment, failing closed on a partial one. */
export function releaseFromEnvironment(env: ReleaseEnvironment): ReleaseIdentity {
  const sha = env.GITHUB_SHA ?? "";
  const tag = env.GITHUB_REF_NAME ?? "";
  return { sha, tag, version: tag.length > 0 ? versionFromTag(tag) : "" };
}

/** Resolve the producing run, failing closed on a partial one. */
export function runFromEnvironment(env: Record<string, string | undefined>): RunIdentity {
  return {
    repository: env["GITHUB_REPOSITORY"] ?? "",
    runId: env["GITHUB_RUN_ID"] ?? "",
    runAttempt: env["GITHUB_RUN_ATTEMPT"] ?? "",
    verifierSha: env["SEMCTX_PROOF_TOOL_SHA"] ?? env["GITHUB_SHA"] ?? "",
  };
}

/** Exit status: `0` only for a whole proof. Any missing, partial or contradictory evidence is `1`. */
export function proofExitCode(proof: StableDeliveryProof): number {
  return proof.ok && proof.stage === "final" ? 0 : 1;
}

// --- Live execution ---------------------------------------------------------------------------

/** The plugin directory each host installs, inside the release tree. */
export const RELEASE_PLUGIN_DIRECTORY: Record<ProofHost, string> = {
  codex: CODEX_PLUGIN,
  claude: "claude-code",
};

export interface CommandOutcome {
  code: number;
  out: string;
  err: string;
}

export interface McpHandshakeOutcome {
  ok: boolean;
  toolCount: number;
  detail: string;
  /** The control freshness verdict the server answered with, archived rather than judged. */
  verdict: string | null;
  /** The child that was started, so a caller can observe it is gone rather than assume it. */
  pid: number | null;
  /** Bytes retained from each stream, and whether either hit its cap. */
  stdoutBytes: number;
  stderrBytes: number;
}

/**
 * Every filesystem, process and clock effect the proof depends on. Injected so each hostile
 * scenario is a deterministic unit test instead of a live release run. Every implementation records
 * the paths it touches, which is what makes isolation provable without reading a user profile.
 */
export interface DeliveryProofRuntime {
  readonly platform: NodeJS.Platform;
  run(command: readonly string[], cwd: string, env: Record<string, string | undefined>): CommandOutcome;
  /** Raw bytes of one blob in a commit, or `null`. The immutable source of every witness. */
  gitBlob(checkout: string, commit: string, path: string, env: Record<string, string | undefined>): Uint8Array | null;
  makeDirectory(path: string): void;
  readTextFile(path: string): string | null;
  writeTextFile(path: string, contents: string): void;
  /** Raw bytes of a regular file. Digesting and copying the *same* buffer is what binds them. */
  readBytes(path: string): Uint8Array | null;
  writeBytes(path: string, bytes: Uint8Array): void;
  /** An unpredictable token used to separate independently materialised execution copies. */
  randomToken(): string;
  /** SHA-256 of a file, or `null` when it is absent, unreadable or not a regular file. */
  digestFile(path: string): string | null;
  /** What a path *is*, without following it. A link is a kind, never a transparent alias. */
  pathKind(path: string): "absent" | "file" | "directory" | "link" | "unreadable";
  /** The fully resolved path, or `null` when it cannot be resolved. */
  realPath(path: string): string | null;
  joinPath(...segments: string[]): string;
  /** Every path this runtime touched, in order. */
  ledger(): readonly LedgerEntry[];
  /**
   * Start the packaged MCP runtime as a real stdio server from `cwd`, complete the protocol
   * handshake, list its tools and call one read-only tool against `repositoryRoot`.
   */
  mcpHandshake(
    bundlePath: string,
    cwd: string,
    repositoryRoot: string,
    env: Record<string, string | undefined>,
  ): Promise<McpHandshakeOutcome>;
}

export interface ProofOptions {
  release: ReleaseIdentity;
  run: RunIdentity;
  /** Checkout of the release commit; source of the immutable bundle witness. */
  releaseCheckout: string;
  /** Sandbox base every host root must live under. */
  sandboxRoot: string;
  /** A repository outside every cache, which the CLI and MCP smokes are launched against. */
  foreignRepository: string;
  /** Where the archived proof is written; part of the allowed surface. */
  proofOutput: string;
  /** Real maintainer roots that must never appear in the ledger. Never opened. */
  forbiddenRoots: readonly string[];
  /** The runner environment. Filtered to an allow-list before any child process sees it. */
  inheritedEnvironment: Record<string, string | undefined>;
}

/**
 * The only inherited variables a child of this proof may see. An allow-list rather than a deny-list:
 * a deny-list has to predict every injection vector a host, Git or a package manager reads, and the
 * one it forgets is the one that aims the run at the maintainer's real profile.
 */
export const PROOF_ENVIRONMENT_ALLOW_LIST: readonly string[] = [
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
  "LANG",
  "LC_ALL",
  "TZ",
];

const ALLOWED_ENVIRONMENT_KEYS = new Set(PROOF_ENVIRONMENT_ALLOW_LIST);

function allowedInheritance(inherited: Record<string, string | undefined>): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(inherited)) {
    // Windows environment names are case-insensitive; the original casing is preserved so a child
    // that looks the variable up literally still finds it.
    if (ALLOWED_ENVIRONMENT_KEYS.has(key.toUpperCase()) && value !== undefined) environment[key] = value;
  }
  return environment;
}

/** Whether an environment can actually launch a provisioned CLI at all. */
export function environmentIsUsable(environment: Record<string, string | undefined>): boolean {
  return Object.entries(environment).some(([key, value]) => key.toUpperCase() === "PATH" && isNonEmpty(value));
}

/**
 * The environment used for the proof's own tooling — Git and npm — outside any host. Homes point
 * into the sandbox so a tool that insists on writing one cannot reach the maintainer's profile.
 */
export function toolchainEnvironment(
  sandboxRoot: string,
  inherited: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  const home = `${sandboxRoot}/toolchain`;
  return {
    ...allowedInheritance(inherited),
    HOME: home,
    USERPROFILE: home,
    TMPDIR: `${home}/tmp`,
    TEMP: `${home}/tmp`,
    TMP: `${home}/tmp`,
  };
}

/**
 * The environment a host is confined to. Nothing is inherited except the small system allow-list;
 * every home, configuration and cache root is *replaced* by a path under the host's temporary root.
 * A `CODEX_HOME`, `HOME` or `XDG_CONFIG_HOME` surviving from the runner would silently aim the whole
 * proof at the maintainer's real profile, which is the one outcome this function exists to make
 * impossible — and a `GIT_*` or `npm_config_*` survivor would let the runner inject behaviour into
 * the commands the proof runs.
 */
export function hostEnvironment(
  host: ProofHost,
  hostRoot: string,
  inherited: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  const environment = allowedInheritance(inherited);
  // `homedir()` reads HOME on POSIX and USERPROFILE on Windows; both hosts derive their root from
  // it, and Codex additionally honours CODEX_HOME. All three are pinned on both hosts so neither
  // platform nor host can fall back to an inherited value.
  environment["HOME"] = hostRoot;
  environment["USERPROFILE"] = hostRoot;
  if (host === "codex") environment["CODEX_HOME"] = `${hostRoot}/.codex`;
  environment["XDG_CONFIG_HOME"] = `${hostRoot}/.config`;
  environment["XDG_DATA_HOME"] = `${hostRoot}/.local/share`;
  environment["XDG_STATE_HOME"] = `${hostRoot}/.local/state`;
  environment["XDG_CACHE_HOME"] = `${hostRoot}/.cache`;
  environment["APPDATA"] = `${hostRoot}/AppData/Roaming`;
  environment["LOCALAPPDATA"] = `${hostRoot}/AppData/Local`;
  environment["TMPDIR"] = `${hostRoot}/tmp`;
  environment["TEMP"] = `${hostRoot}/tmp`;
  environment["TMP"] = `${hostRoot}/tmp`;
  // The plugin MCP resolves its target from SEMCTX_ROOT; an inherited one would retarget the smoke.
  return environment;
}

/** Official, supported host commands. Nothing here reaches around a host's own installer. */
export function installCommands(host: ProofHost): Array<readonly string[]> {
  return host === "codex"
    ? [
        ["codex", "plugin", "marketplace", "add", "hoklims/semctx", "--ref", RELEASE_REF, "--json"],
        ["codex", "plugin", "add", EXPECTED_PLUGIN_ID.codex, "--json"],
      ]
    : [
        ["claude", "plugin", "marketplace", "add", `hoklims/semctx@${RELEASE_REF}`, "--scope", "user"],
        ["claude", "plugin", "install", EXPECTED_PLUGIN_ID.claude, "--scope", "user"],
      ];
}

/** The two read-only queries `pluginDeliveryStatus` already uses. Same shapes, same names. */
export function inventoryCommand(host: ProofHost): readonly string[] {
  return [host, "plugin", "list", "--json"];
}

export function marketplaceCommand(host: ProofHost): readonly string[] {
  return [host, "plugin", "marketplace", "list", "--json"];
}

/** The semver token inside a `--version` banner, or `null` when the CLI printed no version at all. */
export function normaliseCliVersion(raw: string | null): string | null {
  if (!isNonEmpty(raw)) return null;
  let cleaned = "";
  for (const character of raw) {
    const code = character.codePointAt(0) ?? 0;
    cleaned += code < 0x20 || code === 0x7f ? " " : character;
  }
  const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(cleaned);
  return match?.[1] ?? null;
}

function emptyCliObservation(host: ProofHost): HostCliObservation {
  const specification = HOST_CLI_SPECIFICATION[host];
  return {
    requestedPackage: specification.package,
    requestedSpecifier: specification.specifier,
    expectedVersion: specification.version,
    resolvedPackage: null,
    resolvedVersion: null,
    resolutionQueryOk: false,
    packagePresent: false,
    rawVersion: null,
    reportedVersion: null,
  };
}

/**
 * What npm actually installed globally for each pinned specifier. Read from npm rather than assumed
 * from the install command's exit code: `npm install --global` succeeds when a newer version already
 * shadows the pin. A non-zero `npm ls` is *not* an answer, however plausible its stdout looks — npm
 * prints a JSON body alongside its own errors, and parsing that body would turn a failed query into
 * a fabricated resolution.
 */
export function resolveGlobalPackages(
  runtime: DeliveryProofRuntime,
  cwd: string,
  env: Record<string, string | undefined>,
): { ok: boolean; packages: Record<string, string> } {
  // A failed query is not an answer, whatever it printed. npm emits a JSON body alongside its own
  // errors, and parsing that body would turn a broken resolution into a fabricated one.
  const listed = runtime.run(["npm", "ls", "--global", "--depth", "0", "--json"], cwd, env);
  if (listed.code !== 0) return { ok: false, packages: {} };
  const parsed = parseJson(listed.out);
  const dependencies = (parsed as { dependencies?: unknown } | null)?.dependencies;
  if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)) {
    return { ok: false, packages: {} };
  }
  const resolved: Record<string, string> = {};
  for (const [name, entry] of Object.entries(dependencies as Record<string, unknown>)) {
    const version = (entry as { version?: unknown } | null)?.version;
    if (typeof version === "string" && version.trim().length > 0) resolved[name] = version.trim();
  }
  return { ok: true, packages: resolved };
}

/**
 * Read the immutable witness from the **blobs of the published commit**, not from the working tree.
 * A checkout can be edited after `git rev-parse HEAD` answers correctly; a blob addressed as
 * `<commit>:<path>` cannot, because its content is what the commit's hash covers. Both plugins ship
 * their own copy, so each is read separately and `evaluateDeliveryProof` proves the two agree.
 */
export function readWitness(
  runtime: DeliveryProofRuntime,
  checkout: string,
  commit: string,
  host: ProofHost,
  env: Record<string, string | undefined>,
): Record<string, string | null> {
  const witness: Record<string, string | null> = {};
  for (const bundle of PLUGIN_RUNTIME_BUNDLES) {
    const blobPath = `plugins/${RELEASE_PLUGIN_DIRECTORY[host]}/dist/${bundle}`;
    const bytes = isNonEmpty(commit) ? runtime.gitBlob(checkout, commit, blobPath, env) : null;
    witness[bundle] = bytes === null || bytes.length === 0 ? null : digest(bytes);
  }
  return witness;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> =>
      item !== null && typeof item === "object" && !Array.isArray(item))
    : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Bound so a chatty install command cannot bloat the archived artifact. */
const MAX_CAPTURED_COMMAND_OUTPUT = 4000;

/** Keep the first characters and name what was cut, rather than silently discarding the rest. */
export function boundedCommandOutput(value: string): string {
  if (value.length <= MAX_CAPTURED_COMMAND_OUTPUT) return value;
  const cut = value.length - MAX_CAPTURED_COMMAND_OUTPUT;
  return `${value.slice(0, MAX_CAPTURED_COMMAND_OUTPUT)}\n… [truncated ${cut} more characters]`;
}

/** The two `doctor --json` checks that prove the *runtime* rather than the workspace. */
const CLI_SMOKE_REQUIRED_CHECKS: readonly string[] = ["cli", "runtime"];

/**
 * `doctor --json` exits 1 whenever any of its checks is red — including `workspace`, which is
 * legitimately red against the foreign, never-`semctx init`-ed repository this smoke runs against.
 * Exit 0 or 1 is green only when the report is parseable, its version is the released one, and the
 * two checks that prove the *runtime* rather than the workspace — `cli` and `runtime` — are both
 * present and `ok: true`; any other exit code, an unparseable
 * report, a wrong version, or a missing or red required check stays red. This is the exact boundary
 * the HOK-582 incident crossed by reading a bare non-zero exit as "the runtime is broken".
 */
export function evaluateCliSmokeReport(raw: string, expectedVersion: string, detail: string): SmokeOutcome {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { ran: true, ok: false, detail: `${detail}: unparseable report` };
  }
  if (!isRecord(payload)) return { ran: true, ok: false, detail: `${detail}: report is not an object` };
  const version = payload["version"];
  if (version !== expectedVersion) {
    return { ran: true, ok: false, detail: `${detail}: reported v${String(version)}` };
  }
  const checks = payload["checks"];
  if (!Array.isArray(checks)) return { ran: true, ok: false, detail: `${detail}: report carries no checks` };
  for (const name of CLI_SMOKE_REQUIRED_CHECKS) {
    const namedChecks = (checks as unknown[]).filter((entry) => isRecord(entry) && entry["name"] === name);
    if (namedChecks.length === 0) return { ran: true, ok: false, detail: `${detail}: missing the ${name} check` };
    if (namedChecks.length !== 1) return { ran: true, ok: false, detail: `${detail}: duplicate ${name} checks` };
    if ((namedChecks[0] as Record<string, unknown>)["ok"] !== true) {
      return { ran: true, ok: false, detail: `${detail}: the ${name} check is red` };
    }
  }
  return { ran: true, ok: true, detail };
}

/**
 * Exercise the delivered cache itself, from a directory that is neither the cache nor the release
 * checkout. Reading a manifest proves nothing about whether the payload runs, so both entrypoints
 * are actually started — but only after attestation, and only through a path re-admitted at the
 * moment of launch.
 */
export function cliSmoke(
  runtime: DeliveryProofRuntime,
  entry: string,
  options: ProofOptions,
  env: Record<string, string | undefined>,
): SmokeOutcome {
  const detail = `bun ${entry} doctor --root <foreign> --json`;
  const result = runtime.run(
    ["bun", entry, "doctor", "--root", options.foreignRepository, "--json"],
    options.foreignRepository,
    env,
  );
  if (result.code !== 0 && result.code !== 1) {
    return { ran: true, ok: false, detail: `${detail}: exit ${result.code}` };
  }
  return evaluateCliSmokeReport(result.out, options.release.version, detail);
}

/**
 * The MCP runtime is a stdio server, not a CLI: there is no flag that proves it works. The only
 * honest exercise is a real client session — connect, list tools, and call one read-only tool
 * against the foreign repository — which is what `mcpHandshake` performs, under a total deadline.
 */
export async function mcpSmoke(
  runtime: DeliveryProofRuntime,
  entry: string,
  options: ProofOptions,
  env: Record<string, string | undefined>,
): Promise<SmokeOutcome> {
  const detail = `bun ${entry}: stdio initialize, tools/list, ${CONTROL_STATUS_TOOL} from <foreign>`;
  const handshake = await runtime.mcpHandshake(entry, options.foreignRepository, options.foreignRepository, env);
  if (!handshake.ok) return { ran: true, ok: false, detail: `${detail}: ${handshake.detail}` };
  if (handshake.toolCount <= 0) {
    return { ran: true, ok: false, detail: `${detail}: server exposed no tools` };
  }
  // The verdict is archived, never judged: an unsealed foreign fixture is a legitimate answer, and
  // requiring FRESH here would make the smoke a statement about the fixture instead of the runtime.
  return {
    ran: true,
    ok: true,
    detail: `${detail} (${handshake.toolCount} tools, verdict ${handshake.verdict ?? "unreported"})`,
  };
}

export interface MarketplaceSnapshotIdentity {
  commit: string | null;
  ref: string | null;
  source: string | null;
}

/**
 * The identity a host's marketplace snapshot came from. Codex writes source, `ref_name` and
 * revision declaratively; both hosts leave a checkout, so Git is the fallback for commit and ref.
 * This mirrors the existing plugin-delivery authority instead of inventing a convenient list shape.
 */
export function readMarketplaceSnapshotIdentity(
  host: ProofHost,
  runtime: DeliveryProofRuntime,
  access: ConfinedAccess,
  snapshotRoot: string,
  env: Record<string, string | undefined>,
): MarketplaceSnapshotIdentity {
  let commit: string | null = null;
  let ref: string | null = null;
  let source: string | null = null;
  const codexMetadata = runtime.joinPath(snapshotRoot, ".codex-marketplace-install.json");
  // Current Codex releases may omit this legacy declaration. Absence is not an unreadable path:
  // the admitted Git snapshot remains the authority for commit/ref, while a present-but-unsafe
  // declaration is still passed through the strict admission and read path below.
  const declared = host === "codex"
    ? access.readOptional("marketplace.metadata", codexMetadata, snapshotRoot)
    : null;
  if (declared !== null) {
    const record: unknown = parseJson(declared);
    if (record !== null && typeof record === "object" && !Array.isArray(record)) {
      const values = record as Record<string, unknown>;
      commit = text(values["revision"]);
      ref = text(values["ref_name"]);
      source = text(values["source"]);
    }
  }
  if (commit === null || ref === null) {
    // Running Git *inside* the snapshot means the snapshot root is an execution target too.
    const root = access.executable("marketplace.git", snapshotRoot);
    if (root !== null && commit === null) {
      const head = runtime.run(["git", "--no-replace-objects", "rev-parse", "HEAD"], root, env);
      commit = head.code === 0 ? text(head.out) : null;
    }
    if (root !== null && ref === null) {
      const branch = runtime.run(
        ["git", "--no-replace-objects", "rev-parse", "--abbrev-ref", "HEAD"],
        root,
        env,
      );
      const name = branch.code === 0 ? text(branch.out) : null;
      ref = name === "HEAD" ? null : name;
    }
  }
  return { commit, ref, source };
}

/**
 * Whether the authorities that must hold *before* any host is touched actually hold: the checkout
 * is the released commit, both witnesses are complete and agree, and the npm resolution query
 * succeeded. A red report is not enough — an invalid authority must prevent the effects it was
 * supposed to authorise, so a failure here means zero marketplace or install commands anywhere.
 */
export function evaluatePreflight(input: {
  release: ReleaseIdentity;
  checkout: CheckoutObservation;
  witnesses: Record<ProofHost, Record<string, string | null>>;
  resolution: { ok: boolean; packages: Record<string, string> };
}): { ok: boolean; reasons: ProofReason[] } {
  const reasons: ProofReason[] = [
    ...evaluateRelease(input.release),
    ...evaluateCheckout(input.checkout),
    ...evaluateWitnesses(input.witnesses).reasons,
  ];
  if (!input.resolution.ok) reasons.push("HOST_CLI_QUERY_FAILED");
  const unique = [...new Set(reasons)];
  return { ok: unique.length === 0, reasons: unique };
}

/**
 * Install one host into its own temporary root and observe what actually landed. Failures are
 * recorded rather than thrown: an install that failed still has to produce an observation, so the
 * proof reports why it is not delivered instead of losing the run to an exception.
 *
 * The order is the invariant: identity, then install, then inventory, then attestation, and only
 * then execution. Nothing under the cache is started before its bytes match the committed witness.
 */
export async function exerciseHost(
  host: ProofHost,
  options: ProofOptions,
  runtime: DeliveryProofRuntime,
  witness: Record<string, string>,
  resolution: { ok: boolean; packages: Record<string, string> },
  preflightOk: boolean,
): Promise<HostObservation> {
  const hostRoot = runtime.joinPath(options.sandboxRoot, host);
  const env = hostEnvironment(host, hostRoot, options.inheritedEnvironment);
  const specification = HOST_CLI_SPECIFICATION[host];
  const cli = emptyCliObservation(host);
  cli.resolutionQueryOk = resolution.ok;
  cli.packagePresent = resolution.ok && specification.package in resolution.packages;
  const resolvedVersion = resolution.ok ? resolution.packages[specification.package] ?? null : null;
  cli.resolvedVersion = resolvedVersion;
  cli.resolvedPackage = resolvedVersion === null ? null : `${specification.package}@${resolvedVersion}`;

  const observation: HostObservation = {
    host,
    cliAvailable: false,
    environmentUsable: environmentIsUsable(env),
    installSucceeded: false,
    installAttempts: [],
    cli,
    root: hostRoot,
    marketplaceConfigured: false,
    marketplaceSource: null,
    marketplaceRef: null,
    marketplaceRoot: null,
    marketplaceCommit: null,
    reportedVersion: null,
    pluginResolved: false,
    manifestVersion: null,
    cachePath: null,
    pathAdmissions: [],
    bundles: {},
    attested: false,
    executionSnapshots: { cli: null, mcp: null },
    cliSmoke: { ran: false, ok: false, detail: "install did not complete" },
    mcpSmoke: { ran: false, ok: false, detail: "install did not complete" },
  };
  const access = new ConfinedAccess(runtime, options.sandboxRoot, observation.pathAdmissions);
  const refuse = (detail: string): HostObservation => {
    observation.cliSmoke = { ran: false, ok: false, detail };
    observation.mcpSmoke = { ran: false, ok: false, detail };
    return observation;
  };

  // A confined environment that cannot launch anything would make every downstream failure read as
  // "the host is broken" instead of "the proof gave it nothing to run with".
  if (!observation.environmentUsable) return refuse("the confined environment carries no PATH");

  runtime.makeDirectory(hostRoot);
  runtime.makeDirectory(runtime.joinPath(hostRoot, "tmp"));
  const codexHome = env["CODEX_HOME"];
  if (isNonEmpty(codexHome)) runtime.makeDirectory(codexHome);
  // The `--version` probe is read-only and is what *establishes* identity, so it is allowed
  // before the gates below. No mutating host CLI command runs until they pass; creating the
  // confined sandbox roots above is proof scaffolding, not host state inherited from a user.
  const probe = runtime.run([host, "--version"], options.foreignRepository, env);
  cli.rawVersion = text(probe.out) ?? text(probe.err);
  cli.reportedVersion = normaliseCliVersion(cli.rawVersion);
  if (probe.code !== 0) return refuse(`${host} is not available on PATH`);
  observation.cliAvailable = true;

  // Gate 1 — a global authority that does not hold authorises no host effect at all.
  if (!preflightOk) {
    return refuse("global preflight failed; no marketplace or install command was authorised");
  }
  // Gate 2 — this host's CLI must be exactly the pinned package *and* the pinned banner before
  // a single one of its mutating commands runs.
  if (!cliIdentityProven(cli)) {
    return refuse(`${host} CLI identity did not match ${specification.specifier}; nothing was installed`);
  }

  for (const command of installCommands(host)) {
    const result = runtime.run(command, options.foreignRepository, env);
    observation.installAttempts.push({
      argv: command,
      code: result.code,
      stdout: boundedCommandOutput(result.out),
      stderr: boundedCommandOutput(result.err),
    });
    if (result.code !== 0) return observation;
  }
  observation.installSucceeded = true;

  // --- The marketplace the host is configured against, read through its own contract. ------------
  const marketplaces = runtime.run(marketplaceCommand(host), options.foreignRepository, env);
  if (marketplaces.code !== 0) return observation;
  const marketplaceParsed = parseJson(marketplaces.out);
  const marketplaceList = host === "codex"
    ? records((marketplaceParsed as { marketplaces?: unknown } | null)?.marketplaces)
    : records(marketplaceParsed);
  const marketplace = marketplaceList.find((entry) => entry["name"] === MARKETPLACE_NAME);
  if (marketplace === undefined) return observation;
  observation.marketplaceConfigured = true;
  // Codex nests its source; Claude reports the repository slug directly. Neither is invented here.
  observation.marketplaceSource = host === "codex"
    ? text((marketplace["marketplaceSource"] as { source?: unknown } | undefined)?.source)
    : text(marketplace["repo"]);
  // Claude owns `ref` in the list contract. Codex owns `ref_name` in snapshot metadata; never let an
  // incidental/undocumented list property override that authority.
  observation.marketplaceRef = host === "claude" ? text(marketplace["ref"]) : null;
  // Codex names the snapshot root `root`; Claude names it `installLocation`.
  const reportedRoot = host === "codex" ? text(marketplace["root"]) : text(marketplace["installLocation"]);
  const marketplaceRoot = access.admit(`${host}.marketplace`, reportedRoot);
  observation.marketplaceRoot = marketplaceRoot;
  if (marketplaceRoot !== null) {
    const snapshotIdentity = readMarketplaceSnapshotIdentity(host, runtime, access, marketplaceRoot, env);
    observation.marketplaceCommit = snapshotIdentity.commit;
    // Claude reports the tracked ref in its list. Codex records `ref_name` in the marketplace
    // install metadata, and its canonical list shape does not promise a `ref` property.
    observation.marketplaceRef ??= snapshotIdentity.ref;
  }

  // --- The versioned cache the host actually executes. -------------------------------------------
  const inventory = runtime.run(inventoryCommand(host), options.foreignRepository, env);
  if (inventory.code !== 0) return observation;
  const parsed = parseJson(inventory.out);
  const entries = host === "codex"
    ? records((parsed as { installed?: unknown } | null)?.installed)
    : records(parsed);
  const entry = entries.find((candidate) =>
    host === "codex"
      ? candidate["pluginId"] === EXPECTED_PLUGIN_ID.codex
      : candidate["id"] === EXPECTED_PLUGIN_ID.claude && candidate["scope"] === "user");

  const declaredVersion = text(entry?.["version"]);
  // The host-reported version becomes a path segment for Codex. A value that is not a semver token
  // is not a version at all, and must never reach a path join.
  observation.reportedVersion = declaredVersion !== null && VERSION_SEGMENT.test(declaredVersion)
    ? declaredVersion
    : null;
  observation.pluginResolved = entry !== undefined
    && entry["enabled"] === true
    && (host === "claude" || entry["installed"] === true);

  // Codex derives its cache entry from the approved marketplace root, using the shared delivery
  // authority rather than a second derivation that could drift from it.
  const reportedCache = host === "codex"
    ? (marketplaceRoot === null || observation.reportedVersion === null
      ? null
      : codexCacheEntryFromMarketplaceRoot(marketplaceRoot, observation.reportedVersion, hostRoot))
    : text(entry?.["installPath"]);
  const cachePath = access.admit(`${host}.cache`, reportedCache);
  observation.cachePath = cachePath;
  if (cachePath === null) return observation;

  // --- Attestation. Every consumed descendant is admitted again at the moment it is used. --------
  const manifestDirectory = host === "codex" ? ".codex-plugin" : ".claude-plugin";
  const manifest = access.read(
    `${host}.manifest`,
    runtime.joinPath(cachePath, manifestDirectory, "plugin.json"),
    cachePath,
  );
  observation.manifestVersion = manifest === null
    ? null
    : text((parseJson(manifest) as { version?: unknown } | null)?.version);

  // Each bundle is read **once**; that buffer is what gets digested and, if it attests, what gets
  // copied into the execution snapshot. A second read would reopen the rewrite window.
  const attestedBytes: Record<string, Uint8Array> = {};
  for (const bundle of PLUGIN_RUNTIME_BUNDLES) {
    const bytes = access.bytes(
      `${host}.bundle.${bundle}`,
      runtime.joinPath(cachePath, "dist", bundle),
      cachePath,
    );
    observation.bundles[bundle] = bytes === null || bytes.length === 0 ? null : digest(bytes);
    if (bytes !== null && bytes.length > 0) attestedBytes[bundle] = bytes;
  }
  observation.attested = bundlesAttested(observation.bundles, witness);

  const authorityReasons = evaluateExecutionAuthority(
    observation,
    options.release,
    witness,
    options.sandboxRoot,
    runtime.platform,
  );
  if (authorityReasons.length > 0) {
    // The complete execution gate. A red authority may be diagnosed, but it may never be consumed:
    // source, ref, commit, plugin identity, both versions, path admission and bundle attestation all
    // have to hold before even an execution copy is created.
    return refuse(`installed authority failed (${authorityReasons.join(", ")}); nothing was executed`);
  }

  // The cache is **not** what runs. Each consumer gets a fresh copy created from the attested in-memory
  // buffers immediately before it runs. In particular, the CLI never sees the later MCP directory,
  // so it cannot alter the bytes the MCP smoke will consume. These copies close cache and cross-smoke
  // rewrite windows; without an OS sandbox they do not claim protection from an unrelated process
  // already executing as the same user.
  const createExecutionCopy = (purpose: "cli" | "mcp"): string | null => {
    const snapshot = runtime.joinPath(
      options.sandboxRoot,
      "exec",
      `${host}-${purpose}-${runtime.randomToken()}`,
    );
    runtime.makeDirectory(runtime.joinPath(snapshot, "dist"));
    for (const bundle of PLUGIN_RUNTIME_BUNDLES) {
      const bytes = attestedBytes[bundle];
      if (bytes === undefined) return null;
      runtime.writeBytes(runtime.joinPath(snapshot, "dist", bundle), bytes);
    }
    for (const bundle of PLUGIN_RUNTIME_BUNDLES) {
      const copied = access.digest(
        `${host}.snapshot.${purpose}.${bundle}`,
        runtime.joinPath(snapshot, "dist", bundle),
        snapshot,
      );
      if (copied !== witness[bundle]) return null;
    }
    return snapshot;
  };

  const cliSnapshot = createExecutionCopy("cli");
  if (cliSnapshot === null) {
    observation.snapshotFailed = true;
    return refuse("the CLI execution copy did not reproduce the attested bytes; nothing was executed");
  }
  observation.executionSnapshots.cli = cliSnapshot;
  const cliEntry = access.executable(
    `${host}.entry.cli`,
    runtime.joinPath(cliSnapshot, "dist", "semctx.js"),
    cliSnapshot,
  );
  if (cliEntry === null) {
    observation.cliSmoke = { ran: false, ok: false, detail: "the CLI entrypoint was refused at launch" };
    observation.mcpSmoke = { ran: false, ok: false, detail: "the prior execution copy was refused" };
    return observation;
  }
  observation.cliSmoke = cliSmoke(runtime, cliEntry, options, env);

  const mcpSnapshot = createExecutionCopy("mcp");
  if (mcpSnapshot === null) {
    observation.snapshotFailed = true;
    observation.mcpSmoke = { ran: false, ok: false, detail: "the MCP execution copy was refused" };
    return observation;
  }
  observation.executionSnapshots.mcp = mcpSnapshot;
  const mcpEntry = access.executable(
    `${host}.entry.mcp`,
    runtime.joinPath(mcpSnapshot, "dist", "semctx-mcp.js"),
    mcpSnapshot,
  );
  observation.mcpSmoke = mcpEntry === null
    ? { ran: false, ok: false, detail: "the MCP entrypoint was refused at launch" }
    : await mcpSmoke(runtime, mcpEntry, options, env);
  return observation;
}

/**
 * Run the whole proof, trust before effect: the checkout is proven to be the released commit, the
 * CLI identities are proven, the witness is read from the commit's blobs, and only then is a host
 * installed, attested and — if attested — executed.
 */
export async function runStableDeliveryProof(
  options: ProofOptions,
  runtime: DeliveryProofRuntime,
): Promise<StableDeliveryProof> {
  runtime.makeDirectory(options.sandboxRoot);
  const toolchain = toolchainEnvironment(options.sandboxRoot, options.inheritedEnvironment);

  const head = runtime.run(
    ["git", "--no-replace-objects", "rev-parse", "HEAD"],
    options.releaseCheckout,
    toolchain,
  );
  const observedHead = head.code === 0 ? text(head.out) : null;
  const checkout: CheckoutObservation = {
    path: options.releaseCheckout,
    expected: options.release.sha,
    head: observedHead,
  };

  // The witness is addressed by the released commit, so a checkout whose head is wrong yields no
  // witness at all rather than a witness of the wrong tree.
  const witnessCommit = observedHead === options.release.sha ? options.release.sha : "";
  const witnesses = {
    codex: readWitness(runtime, options.releaseCheckout, witnessCommit, "codex", toolchain),
    claude: readWitness(runtime, options.releaseCheckout, witnessCommit, "claude", toolchain),
  };
  const extraReasons: ProofReason[] = [];
  if (witnessCommit === "") extraReasons.push("WITNESS_NOT_FROM_COMMIT");

  const agreed = evaluateWitnesses(witnesses).agreed;
  const resolution = resolveGlobalPackages(runtime, options.releaseCheckout, toolchain);

  // Everything above is an authority. If any of it does not hold, no host is installed at all —
  // a red report after the fact would still have let the effects happen.
  const preflight = evaluatePreflight({ release: options.release, checkout, witnesses, resolution });
  if (!preflight.ok) extraReasons.push("PREFLIGHT_FAILED");

  const hosts: HostObservation[] = [];
  for (const host of PROOF_HOSTS) {
    hosts.push(await exerciseHost(host, options, runtime, agreed, resolution, preflight.ok));
  }

  return evaluateDeliveryProof({
    release: options.release,
    run: options.run,
    checkout,
    witnesses,
    isolation: {
      sandboxRoot: options.sandboxRoot,
      allowedRoots: [options.sandboxRoot, options.releaseCheckout, options.foreignRepository, options.proofOutput],
      forbiddenRoots: options.forbiddenRoots,
      ledger: runtime.ledger(),
    },
    hosts,
    platform: runtime.platform,
    extraReasons,
  });
}

// --- MCP protocol validation --------------------------------------------------------------------

export const CONTROL_STATUS_TOOL = "semctx_control_status";
const MCP_PROTOCOL_VERSION = "2025-06-18";
const CONTROL_STATUS_KIND = "control_freshness_status";
const CONTROL_STATUS_BASIS = "control_index_snapshot_v1";
const CONTROL_STATUS_VERDICTS = new Set(["FRESH", "DIRTY_KNOWN", "STALE", "UNSEALED"]);

export interface McpResponseVerdict {
  ok: boolean;
  detail: string;
  /** Present only for a well-formed `semctx_control_status` payload. */
  verdict: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * A JSON-RPC response is only a response when it is one: right envelope, right id, and exactly one
 * of `result` or `error`. Treating "no `error` key" as success accepts a notification, a response to
 * a different request, and a bare `{}` — all of which a hung or confused server can emit.
 */
export function evaluateJsonRpcResponse(message: unknown, expectedId: number, method: string): McpResponseVerdict {
  const refuse = (detail: string): McpResponseVerdict => ({ ok: false, detail: `${method}: ${detail}`, verdict: null });
  if (!isRecord(message)) return refuse("response is not a JSON-RPC object");
  if (message["jsonrpc"] !== "2.0") return refuse("wrong jsonrpc envelope");
  if (message["id"] !== expectedId) return refuse("response id does not match the request");
  if (message["error"] !== undefined) return refuse("server returned an error");
  if (!isRecord(message["result"])) return refuse("result is missing or malformed");
  return { ok: true, detail: `${method}: ok`, verdict: null };
}

function isMcpImplementation(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || !isNonEmpty(text(value["name"])) || !isNonEmpty(text(value["version"]))) return false;
  for (const field of ["title", "websiteUrl", "description"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string") return false;
  }
  return value["icons"] === undefined
    || (Array.isArray(value["icons"]) && value["icons"].every(isMcpIcon));
}

function hasOptionalBooleanFields(value: unknown, fields: readonly string[]): boolean {
  return isRecord(value) && fields.every((field) => value[field] === undefined || typeof value[field] === "boolean");
}

function isMcpServerCapabilities(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  if (value["experimental"] !== undefined
    && (!isRecord(value["experimental"])
      || !Object.values(value["experimental"]).every(isRecord))) return false;
  for (const field of ["logging", "completions"] as const) {
    if (value[field] !== undefined && !isRecord(value[field])) return false;
  }
  if (value["prompts"] !== undefined && !hasOptionalBooleanFields(value["prompts"], ["listChanged"])) return false;
  if (value["resources"] !== undefined
    && !hasOptionalBooleanFields(value["resources"], ["subscribe", "listChanged"])) return false;
  return value["tools"] === undefined || hasOptionalBooleanFields(value["tools"], ["listChanged"]);
}

/** Validate the required, version-bound shape a conforming MCP client consumes before discovery. */
export function evaluateInitializeResponse(message: unknown, expectedId: number): McpResponseVerdict {
  const envelope = evaluateJsonRpcResponse(message, expectedId, "initialize");
  if (!envelope.ok) return envelope;
  const result = (message as Record<string, unknown>)["result"] as Record<string, unknown>;
  if (result["protocolVersion"] !== MCP_PROTOCOL_VERSION) {
    return { ok: false, detail: "initialize: server did not negotiate protocol 2025-06-18", verdict: null };
  }
  const capabilities = result["capabilities"];
  if (!isMcpServerCapabilities(capabilities)) {
    return { ok: false, detail: "initialize: capabilities are missing or malformed", verdict: null };
  }
  if (!isRecord(capabilities["tools"])) {
    return { ok: false, detail: "initialize: server did not advertise the tools capability", verdict: null };
  }
  if (!isMcpImplementation(result["serverInfo"])) {
    return { ok: false, detail: "initialize: serverInfo is missing or malformed", verdict: null };
  }
  if (result["instructions"] !== undefined && typeof result["instructions"] !== "string") {
    return { ok: false, detail: "initialize: instructions are malformed", verdict: null };
  }
  if (result["_meta"] !== undefined && !isRecord(result["_meta"])) {
    return { ok: false, detail: "initialize: metadata is malformed", verdict: null };
  }
  return { ok: true, detail: "initialize: ok", verdict: null };
}

function isMcpObjectSchema(schema: unknown): schema is Record<string, unknown> {
  if (!isRecord(schema) || schema["type"] !== "object") return false;
  if (schema["properties"] !== undefined
    && (!isRecord(schema["properties"])
      || !Object.values(schema["properties"]).every(isRecord))) return false;
  if (schema["required"] !== undefined
    && (!Array.isArray(schema["required"])
      || !schema["required"].every((entry: unknown) => typeof entry === "string"))) return false;
  return schema["$schema"] === undefined || typeof schema["$schema"] === "string";
}

function isMcpToolAnnotations(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value["title"] !== undefined && typeof value["title"] !== "string") return false;
  return ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]
    .every((field) => value[field] === undefined || typeof value[field] === "boolean");
}

function isMcpToolExecution(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const taskSupport = value["taskSupport"];
  return taskSupport === undefined || taskSupport === "required"
    || taskSupport === "optional" || taskSupport === "forbidden";
}

function isMcpIcon(value: unknown): boolean {
  return isRecord(value) && typeof value["src"] === "string"
    && (value["mimeType"] === undefined || typeof value["mimeType"] === "string")
    && (value["sizes"] === undefined
      || (Array.isArray(value["sizes"]) && value["sizes"].every((entry: unknown) => typeof entry === "string")))
    && (value["theme"] === undefined || value["theme"] === "light" || value["theme"] === "dark");
}

function isMcpToolDescriptor(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || !isNonEmpty(text(value["name"]))) return false;
  for (const field of ["title", "description"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string") return false;
  }
  if (!isMcpObjectSchema(value["inputSchema"])) return false;
  if (value["outputSchema"] !== undefined && !isMcpObjectSchema(value["outputSchema"])) return false;
  if (value["annotations"] !== undefined && !isMcpToolAnnotations(value["annotations"])) return false;
  if (value["execution"] !== undefined && !isMcpToolExecution(value["execution"])) return false;
  if (value["_meta"] !== undefined && !isRecord(value["_meta"])) return false;
  return value["icons"] === undefined
    || (Array.isArray(value["icons"]) && value["icons"].every(isMcpIcon));
}

/**
 * A `tools/call` succeeded only when the server also says it did *and* the payload is the contract
 * the tool declares. `isError: true` travels inside a syntactically valid result, so a handshake
 * that stops at the envelope reports a refusal as a success — and a result whose body is not a
 * `control_freshness_status` report proves the server answered, not that it answered this tool.
 */
export function evaluateControlStatusResponse(message: unknown, expectedId: number): McpResponseVerdict {
  const envelope = evaluateJsonRpcResponse(message, expectedId, CONTROL_STATUS_TOOL);
  if (!envelope.ok) return envelope;
  const refuse = (detail: string): McpResponseVerdict =>
    ({ ok: false, detail: `${CONTROL_STATUS_TOOL}: ${detail}`, verdict: null });

  const result = (message as Record<string, unknown>)["result"] as Record<string, unknown>;
  if (result["isError"] === true) return refuse("tool reported isError");

  const content: unknown = result["content"];
  if (!Array.isArray(content) || content.length === 0) return refuse("result carries no content");
  const first: unknown = (content as unknown[])[0];
  if (!isRecord(first) || first["type"] !== "text" || typeof first["text"] !== "string") {
    return refuse("result content is not a text block");
  }

  const payload = result["structuredContent"] !== undefined
    ? result["structuredContent"]
    : parseJson(first["text"]);
  if (!isRecord(payload)) return refuse("payload is not a control report");
  if (payload["schemaVersion"] !== 1) return refuse("payload schema version is not 1");
  if (payload["kind"] !== CONTROL_STATUS_KIND) return refuse("payload is not a control freshness status");
  if (payload["basis"] !== CONTROL_STATUS_BASIS) return refuse("payload basis is not the control index snapshot");
  if (typeof payload["canRunHighRiskControl"] !== "boolean") return refuse("payload omits canRunHighRiskControl");
  if (!Array.isArray(payload["reasons"])) return refuse("payload omits reasons");
  if (!("freshnessSeal" in payload)) return refuse("payload omits freshnessSeal");
  const verdict = payload["verdict"];
  if (typeof verdict !== "string" || !CONTROL_STATUS_VERDICTS.has(verdict)) {
    return refuse("payload carries no recognised verdict");
  }

  return { ok: true, detail: `${CONTROL_STATUS_TOOL}: ${verdict}`, verdict };
}

// --- Default runtime --------------------------------------------------------------------------

/** Bound so a hung host command cannot stall the release workflow. */
const HOST_COMMAND_TIMEOUT_MS = 300_000;

/**
 * Every bound on the MCP child's life. A per-request timeout alone leaves three ways to hang: a
 * server that never writes a newline, a server that ignores termination, and a teardown that waits
 * forever for a pipe to close. Each gets its own bound.
 */
export interface McpLimits {
  /**
   * Ceiling on the protocol exchange alone. It is deliberately **not** called a total: teardown
   * still has to be given a real budget, because a teardown clamped to zero would return promptly
   * while leaving a live child behind — the opposite of the guarantee. `mcpWorstCaseMs` states the
   * actual worst case this function can take.
   */
  exchangeDeadlineMs: number;
  requestTimeoutMs: number;
  /** Pagination ceiling so a fresh cursor on every page cannot consume the whole release job. */
  maxToolPages: number;
  /** Total stdout *seen*; exceeding it without a newline is a protocol failure, not backpressure. */
  stdoutMaxBytes: number;
  /**
   * Cap on stderr text **retained** for the report. The stream itself is drained continuously and
   * without bound, which is what keeps a chatty server from blocking on a full pipe; only what is
   * kept in memory is capped.
   */
  stderrMaxBytes: number;
  /** How long a polite termination is given before the forced one. */
  terminateGraceMs: number;
  /** How long teardown may wait for streams and the child to settle. */
  teardownMs: number;
}

/** The declared worst case for one handshake: the exchange, plus every bounded teardown wait. */
export function mcpWorstCaseMs(limits: McpLimits): number {
  return limits.exchangeDeadlineMs + limits.terminateGraceMs + limits.teardownMs * 3;
}

export const DEFAULT_MCP_LIMITS: McpLimits = {
  exchangeDeadlineMs: 180_000,
  requestTimeoutMs: 120_000,
  maxToolPages: 16,
  stdoutMaxBytes: 8 * 1024 * 1024,
  stderrMaxBytes: 64 * 1024,
  terminateGraceMs: 2_000,
  teardownMs: 5_000,
};

/** Resolve after `ms`, with a timer that is always cleared — a leaked one outlives the verdict. */
function delay(ms: number): { promise: Promise<"timeout">; cancel: () => void } {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<"timeout">((resolve) => {
    handle = setTimeout(() => resolve("timeout"), ms);
  });
  return { promise, cancel: () => { if (handle !== undefined) clearTimeout(handle); } };
}

/** Await a promise but never longer than `ms`, and never leave the timer behind. */
async function within<T>(task: Promise<T>, ms: number): Promise<T | "timeout"> {
  const timer = delay(ms);
  try {
    return await Promise.race([task, timer.promise]);
  } finally {
    timer.cancel();
  }
}

/**
 * Speak the MCP stdio protocol directly — newline-delimited JSON-RPC — rather than adding a client
 * package. The plugin runtime is the server under test, so the proof must not depend on a second
 * implementation of the same protocol being installed alongside it.
 *
  * The direct child's exchange and teardown waits are bounded. Stdout bytes seen and stderr bytes
  * retained are capped, with a polite termination escalated to a forced one. This does not claim a
  * process-tree sandbox: the archived PID is the direct child whose exit is observed.
 */
export async function defaultMcpHandshake(
  bundlePath: string,
  cwd: string,
  repositoryRoot: string,
  env: Record<string, string | undefined>,
  limits: McpLimits = DEFAULT_MCP_LIMITS,
): Promise<McpHandshakeOutcome> {
  const child = Bun.spawn(["bun", bundlePath], {
    cwd,
    env: env as Record<string, string>,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const pending = new Map<number, { settle: (message: Record<string, unknown>) => void; fail: (cause: Error) => void }>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let identifier = 0;
  let stderrText = "";
  let stderrBytes = 0;
  let stdoutBytes = 0;
  let overflowed = false;

  const failAll = (cause: Error): void => {
    for (const [id, waiter] of [...pending]) {
      pending.delete(id);
      waiter.fail(cause);
    }
  };

  // stderr is drained and bounded: an unread pipe blocks the writer, and a server blocked on stderr
  // never answers on stdout, which would turn a chatty server into a timeout.
  const drain = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr) {
      if (stderrBytes < limits.stderrMaxBytes) {
        const retained = chunk.subarray(0, limits.stderrMaxBytes - stderrBytes);
        stderrBytes += retained.length;
        stderrText += decoder.decode(retained, { stream: true });
      }
    }
    stderrText += decoder.decode();
  })();

  const reader = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of child.stdout) {
      stdoutBytes += chunk.length;
      // A server that never emits a newline would otherwise grow this buffer without bound: the cap
      // is on bytes seen, so a flood is a protocol failure rather than a memory problem.
      if (stdoutBytes > limits.stdoutMaxBytes) {
        overflowed = true;
        failAll(new Error(`server exceeded the ${limits.stdoutMaxBytes}-byte stdout bound`));
        return;
      }
      buffer += decoder.decode(chunk, { stream: true });
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line.length > 0) {
          try {
            const message = JSON.parse(line) as Record<string, unknown>;
            const waiter = pending.get(message["id"] as number);
            if (waiter !== undefined) {
              pending.delete(message["id"] as number);
              waiter.settle(message);
            }
          } catch {
            // A non-JSON line is server noise, not a response.
          }
        }
        index = buffer.indexOf("\n");
      }
    }
    // The stream closed: nothing further can arrive, so waiting for the timeout would only delay a
    // verdict that is already decided.
    failAll(new Error("server closed its output stream"));
  })();

  function request(method: string, params: unknown): { id: number; response: Promise<Record<string, unknown>> } {
    identifier += 1;
    const id = identifier;
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        timers.delete(timer);
        reject(new Error(`timed out on ${method}`));
      }, limits.requestTimeoutMs);
      timers.add(timer);
      const clear = (): void => {
        clearTimeout(timer);
        timers.delete(timer);
      };
      pending.set(id, {
        settle: (message) => { clear(); resolve(message); },
        fail: (cause) => { clear(); reject(cause); },
      });
      try {
        void child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch (cause) {
        clear();
        pending.delete(id);
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
    return { id, response };
  }

  const trailer = (): string => (stderrText.trim().length > 0 ? ` (stderr: ${stderrText.trim().slice(0, 300)})` : "");

  type ExchangeVerdict = Omit<McpHandshakeOutcome, "pid" | "stdoutBytes" | "stderrBytes">;
  const seal = (verdict: ExchangeVerdict): McpHandshakeOutcome =>
    ({ ...verdict, pid: child.pid ?? null, stdoutBytes, stderrBytes });

  const exchange = (async (): Promise<ExchangeVerdict> => {
    const initialize = request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "semctx-stable-delivery-proof", version: "1" },
    });
    const initialized = evaluateInitializeResponse(await initialize.response, initialize.id);
    if (!initialized.ok) return { ok: false, toolCount: 0, detail: initialized.detail, verdict: null };
    void child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);

    const tools: unknown[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let pageCount = 0;
    while (true) {
      pageCount += 1;
      if (pageCount > limits.maxToolPages) {
        return { ok: false, toolCount: tools.length, detail: "tools/list exceeded the page limit", verdict: null };
      }
      const list = request("tools/list", cursor === undefined ? {} : { cursor });
      const listed = await list.response;
      const listVerdict = evaluateJsonRpcResponse(listed, list.id, "tools/list");
      if (!listVerdict.ok) return { ok: false, toolCount: tools.length, detail: listVerdict.detail, verdict: null };
      const result = listed["result"] as Record<string, unknown>;
      const rawTools = result["tools"];
      if (!Array.isArray(rawTools)) {
        return { ok: false, toolCount: tools.length, detail: "tools/list returned a malformed result", verdict: null };
      }
      if (result["_meta"] !== undefined && !isRecord(result["_meta"])) {
        return { ok: false, toolCount: tools.length, detail: "tools/list returned malformed metadata", verdict: null };
      }
      if (!rawTools.every(isMcpToolDescriptor)) {
        return {
          ok: false,
          toolCount: tools.length + rawTools.length,
          detail: "tools/list returned a malformed tool catalogue",
          verdict: null,
        };
      }
      tools.push(...rawTools);
      const nextCursor = result["nextCursor"];
      if (nextCursor === undefined) break;
      if (typeof nextCursor !== "string") {
        return { ok: false, toolCount: tools.length, detail: "tools/list returned a malformed cursor", verdict: null };
      }
      if (cursors.has(nextCursor)) {
        return { ok: false, toolCount: tools.length, detail: "tools/list repeated a cursor", verdict: null };
      }
      cursors.add(nextCursor);
      cursor = nextCursor;
    }
    const toolCount = tools.length;
    if (toolCount === 0) {
      return { ok: false, toolCount: 0, detail: "tools/list returned nothing", verdict: null };
    }
    if (!tools.some((tool) => isRecord(tool) && tool["name"] === CONTROL_STATUS_TOOL)) {
      return { ok: false, toolCount, detail: `${CONTROL_STATUS_TOOL} was not advertised by tools/list`, verdict: null };
    }

    // Call one read-only tool so the smoke proves the server answers its own contract, not merely
    // that it starts and can enumerate names.
    const call = request("tools/call", { name: CONTROL_STATUS_TOOL, arguments: { repositoryRoot } });
    const called = evaluateControlStatusResponse(await call.response, call.id);
    if (!called.ok) return { ok: false, toolCount, detail: called.detail, verdict: null };
    return { ok: true, toolCount, detail: called.detail, verdict: called.verdict };
  })();

  try {
    const settled = await within(exchange.catch((cause: unknown) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      return { ok: false, toolCount: 0, detail: message, verdict: null } satisfies ExchangeVerdict;
    }), limits.exchangeDeadlineMs);
    if (settled === "timeout") {
      return seal({ ok: false, toolCount: 0, detail: "exceeded the exchange deadline" + trailer(), verdict: null });
    }
    if (overflowed && settled.ok) {
      return seal({ ok: false, toolCount: settled.toolCount, detail: "server flooded stdout", verdict: null });
    }
    return seal(settled.ok ? settled : { ...settled, detail: settled.detail + trailer() });
  } finally {
    // Every timer is cleared, every waiter released, and the child is terminated then forced: a
    // server that ignores the polite signal must not keep the release runner open.
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    failAll(new Error("handshake finished"));
    try { void child.stdin.end(); } catch { /* the pipe may already be gone */ }
    child.kill();
    if (await within(child.exited.catch(() => 0), limits.terminateGraceMs) === "timeout") {
      // A child that ignores the polite signal must still not survive the job. SIGKILL cannot be
      // caught or ignored; on Windows Bun maps it to a forced termination.
      try { child.kill("SIGKILL"); } catch { /* already reaped */ }
      await within(child.exited.catch(() => 0), limits.teardownMs);
    }
    await within(reader.catch(() => undefined), limits.teardownMs);
    await within(drain.catch(() => undefined), limits.teardownMs);
  }
}

export function defaultProofRuntime(limits: McpLimits = DEFAULT_MCP_LIMITS): DeliveryProofRuntime {
  const ledger: LedgerEntry[] = [];
  const note = (operation: LedgerEntry["operation"], path: string): void => { ledger.push({ operation, path }); };

  return {
    platform: process.platform,
    run(command, cwd, env) {
      note("exec", cwd);
      const result = Bun.spawnSync([...command], {
        cwd,
        env: env as Record<string, string>,
        stdout: "pipe",
        stderr: "pipe",
        timeout: HOST_COMMAND_TIMEOUT_MS,
      });
      return {
        code: result.exitCode ?? 1,
        out: new TextDecoder().decode(result.stdout),
        err: new TextDecoder().decode(result.stderr),
      };
    },
    gitBlob(checkout, commit, path, env) {
      note("blob", checkout);
      const result = Bun.spawnSync(["git", "--no-replace-objects", "cat-file", "blob", `${commit}:${path}`], {
        cwd: checkout,
        env: env as Record<string, string>,
        stdout: "pipe",
        stderr: "pipe",
        timeout: HOST_COMMAND_TIMEOUT_MS,
      });
      return result.exitCode === 0 ? new Uint8Array(result.stdout) : null;
    },
    makeDirectory(target) {
      note("make", target);
      mkdirSync(target, { recursive: true });
    },
    readTextFile(target) {
      note("read", target);
      try {
        return readFileSync(target, "utf8");
      } catch {
        return null;
      }
    },
    writeTextFile(target, contents) {
      note("write", target);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, contents, "utf8");
    },
    readBytes(target) {
      note("read", target);
      try {
        const stats = lstatSync(target);
        if (!stats.isFile()) return null;
        return new Uint8Array(readFileSync(target));
      } catch {
        return null;
      }
    },
    writeBytes(target, bytes) {
      note("write", target);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    },
    randomToken() {
      return randomBytes(16).toString("hex");
    },
    digestFile(target) {
      note("digest", target);
      try {
        const stats = lstatSync(target);
        if (!stats.isFile() || stats.size === 0) return null;
        return createHash("sha256").update(readFileSync(target)).digest("hex");
      } catch {
        return null;
      }
    },
    pathKind(target) {
      note("stat", target);
      try {
        const stats = lstatSync(target);
        // Windows junctions and most reparse points are reported as links by `lstat`; the ones that
        // are not are caught by the `realPath` comparison in `admitHostPath`.
        if (stats.isSymbolicLink()) return "link";
        if (stats.isDirectory()) return "directory";
        if (stats.isFile()) return "file";
        return "unreadable";
      } catch (cause) {
        return (cause as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable";
      }
    },
    realPath(target) {
      note("stat", target);
      try {
        return realpathSync.native(target);
      } catch {
        return null;
      }
    },
    joinPath(...segments) {
      return resolve(join(...segments));
    },
    ledger: () => ledger,
    mcpHandshake: (bundlePath, cwd, repositoryRoot, env) => {
      note("exec", cwd);
      return defaultMcpHandshake(bundlePath, cwd, repositoryRoot, env, limits);
    },
  };
}

// --- Entrypoint ---------------------------------------------------------------------------------

/**
 * A proof that observed nothing. Composed through the same evaluator as a real run so an aborted
 * artifact has the identical shape a consumer already parses — a bespoke error envelope would be a
 * second schema nobody validates.
 */
export function abortedProof(
  release: ReleaseIdentity,
  run: RunIdentity,
  reason: ProofReason,
  detail: string,
  platform: NodeJS.Platform = process.platform,
  stage: ProofStage = "final",
): StableDeliveryProof {
  const empty: Record<string, string | null> = {};
  for (const bundle of PLUGIN_RUNTIME_BUNDLES) empty[bundle] = null;
  const proof = evaluateDeliveryProof({
    release,
    run,
    checkout: { path: "", expected: release.sha, head: null },
    witnesses: { codex: { ...empty }, claude: { ...empty } },
    isolation: { sandboxRoot: null, allowedRoots: [], forbiddenRoots: [], ledger: [] },
    hosts: [],
    platform,
    detail,
  });
  return { ...proof, stage, ok: false, reasons: [...new Set([reason, ...proof.reasons])] };
}

/**
 * The JSON the *workflow* writes before this script can be imported, so a provisioning, import,
 * syntax or startup failure still leaves a parseable diagnostic at the uploaded path. It is never
 * evidence: `stage: "placeholder"` is what the readback refuses.
 */
export function placeholderProof(release: ReleaseIdentity, run: RunIdentity): StableDeliveryProof {
  return abortedProof(release, run, "PROOF_NOT_COMPLETED", "the proof script never produced a verdict", "linux", "placeholder");
}

/** Whether a parsed artifact is shaped enough to have its identity and stage checked at all. */
function isProofArtifact(
  value: unknown,
): value is Pick<StableDeliveryProof, "schemaVersion" | "kind" | "release" | "run" | "stage" | "ok"> {
  if (!isRecord(value)) return false;
  return isRecord(value["release"]) && isRecord(value["run"])
    && typeof value["schemaVersion"] === "number" && typeof value["kind"] === "string"
    && typeof value["stage"] === "string" && typeof value["ok"] === "boolean";
}

function renderProof(proof: StableDeliveryProof): string {
  return `${JSON.stringify(proof, null, 2)}\n`;
}

/**
 * The runtime is a parameter so the uploaded-artifact path — the one behaviour that only exists in
 * `main` — can be proven without a release. It defaults to the real one, so production takes the
 * same route the tests exercise rather than a parallel one.
 */
export async function main(
  env: Record<string, string | undefined> = process.env,
  runtime: DeliveryProofRuntime = defaultProofRuntime(),
): Promise<number> {
  const release = releaseFromEnvironment(env);
  const run = runFromEnvironment(env);
  const output = env["SEMCTX_DELIVERY_PROOF_OUTPUT"];

  const archive = (proof: StableDeliveryProof): boolean => {
    if (output === undefined) return false;
    try {
      runtime.writeTextFile(output, renderProof(proof));
      return true;
    } catch (cause) {
      // The artifact is the diagnostic channel; losing it is reported, never swallowed silently.
      console.error(`[delivery-proof] could not write ${output}: ${String(cause)}`);
      return false;
    }
  };

  // Assigned on every path below, including the catch: the workflow's placeholder is what covers
  // the window before this function exists, so there is nothing left for an initial value to guard.
  let proof: StableDeliveryProof;
  try {
    const sandboxRoot = env["SEMCTX_DELIVERY_SANDBOX"];
    const releaseCheckout = env["SEMCTX_RELEASE_CHECKOUT"];
    const foreignRepository = env["SEMCTX_FOREIGN_REPOSITORY"];
    if (sandboxRoot === undefined || releaseCheckout === undefined || foreignRepository === undefined
      || output === undefined) {
      const detail = "SEMCTX_DELIVERY_SANDBOX, SEMCTX_RELEASE_CHECKOUT, SEMCTX_FOREIGN_REPOSITORY"
        + " and SEMCTX_DELIVERY_PROOF_OUTPUT are required";
      console.error(`[delivery-proof] ${detail}`);
      proof = abortedProof(release, run, "PROOF_INPUT_INCOMPLETE", detail, runtime.platform);
    } else {
      const home = env["HOME"] ?? env["USERPROFILE"] ?? ".";
      proof = await runStableDeliveryProof(
        {
          release,
          run,
          releaseCheckout,
          sandboxRoot,
          foreignRepository,
          proofOutput: output,
          // Named so the ledger can prove this orchestrator never touched or opened them.
          forbiddenRoots: [runtime.joinPath(home, ".codex"), runtime.joinPath(home, ".claude")],
          inheritedEnvironment: env,
        },
        runtime,
      );
    }
  } catch (cause) {
    const detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    proof = abortedProof(release, run, "PROOF_ABORTED", detail, runtime.platform);
  }

  const written = archive(proof);
  if (!written) {
    // The final write is what the workflow uploads. If it did not land, the artifact on disk is the
    // workflow's placeholder — evidence of nothing — so the job must be red regardless of `proof`.
    console.error("[delivery-proof] the final artifact was not written; the archived bytes are not this verdict");
    console.log(renderProof(proof));
    return 1;
  }

  // The exit status follows the bytes that were actually archived, not the object in memory. The
  // decisive check is *byte equality* with the rendering of the verdict this run computed: a
  // structural re-validation would still accept a minimal hand-written JSON that carries only
  // `schemaVersion`, `kind`, `stage`, `ok`, `release` and `run`. Equality accepts exactly one
  // document — the one produced here — so a truncated write, a partial rewrite, a flipped `ok`, a
  // placeholder left in place and an archive from another attempt all fail the same way.
  const expected = renderProof(proof);
  const archived = runtime.readTextFile(output as string);
  const parsed = archived === null ? null : parseJson(archived);
  if (!isProofArtifact(parsed)) {
    proof = abortedProof(release, run, "PROOF_ARTIFACT_UNREADABLE", `the artifact at ${String(output)} is not a proof`, runtime.platform);
    archive(proof);
    console.log(renderProof(proof));
    return 1;
  }
  if (parsed.stage !== "final") {
    proof = abortedProof(release, run, "PROOF_PLACEHOLDER_NOT_REPLACED", `the artifact at ${String(output)} is still a ${parsed.stage}`, runtime.platform);
    archive(proof);
    console.log(renderProof(proof));
    return 1;
  }
  if (!proofBelongsToRun(parsed, release, run)) {
    proof = abortedProof(release, run, "PROOF_NOT_BOUND_TO_RUN", `the artifact at ${String(output)} does not belong to this run`, runtime.platform);
    archive(proof);
    console.log(renderProof(proof));
    return 1;
  }
  if (archived !== expected) {
    proof = abortedProof(release, run, "PROOF_ARCHIVE_MISMATCH", `the artifact at ${String(output)} is not the verdict this run computed`, runtime.platform);
    archive(proof);
    console.log(renderProof(proof));
    return 1;
  }

  console.log(renderProof(proof));
  return parsed.ok ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = await main();
}
