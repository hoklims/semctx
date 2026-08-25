import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  type Dirent,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Cross-host plugin delivery observability.
 *
 * Five states are reported and never conflated:
 *
 * 1. the repository checkout (`main`) — informative only;
 * 2. the public `stable` release — the only channel a host installs from;
 * 3. the marketplace snapshot each host approved;
 * 4. the versioned cache each host actually executes;
 * 5. the version a running session loaded, when — and only when — that is observable.
 *
 * The whole surface is read-only with respect to plugin delivery state: it never adds, updates,
 * upgrades, removes, enables or promotes anything, and Semctx itself never writes inside the
 * inspected project or a host's tree. A host inventory command may maintain its own operational
 * bookkeeping (Claude currently records `.in_use` markers); that is host-owned process state, not a
 * plugin delivery mutation. Any unavailable, malformed, or partial evidence produces an explicit
 * `UNKNOWN`, never an optimistic `UP_TO_DATE`.
 *
 * Two modes, and they differ in exactly one respect:
 *
 * - **default** — host `list` queries and local reads only. No network operation of any kind.
 * - **`--attest`** — additionally resolves and *fetches* the canonical public release into a
 *   throwaway store outside the project, then deletes it. This is a real network transfer, opt-in
 *   by name, and it is the only one. Saying "never fetches" of the whole command would be false;
 *   what holds is that nothing is fetched implicitly and Semctx's only write is the disposable
 *   attestation store.
 */

export const PLUGIN_DELIVERY_SCHEMA_VERSION = 1;

/** The release-managed channel both installers register. `main` is never a delivery channel. */
export const PLUGIN_DELIVERY_RELEASE_REF = "stable";

/**
 * The canonical public authority, as a constant of this build.
 *
 * It is deliberately *not* derived from the inspected project: `origin`, `url.*.insteadOf`,
 * credential helpers and every other mutable local configuration are exactly what an attestation
 * must not be able to depend on. A project being inspected is a consumer, never a trust root.
 */
export const PLUGIN_DELIVERY_RELEASE_URL = "https://github.com/hoklims/semctx.git";

/** Where an attestation parks the fetched release inside its own throwaway object store. */
const ATTESTED_RELEASE_REF = "refs/semctx-attestation/stable";

/** Windows can hold a just-exited Git process's handles briefly; removal is retried, then proven. */
const SCRATCH_REMOVAL_ATTEMPTS = 20;
const SCRATCH_REMOVAL_RETRY_MS = 50;

const MARKETPLACE_NAME = "semctx-stable";
const CODEX_PLUGIN = "semctx-control";
const CLAUDE_PLUGIN = "semctx";
/** The Claude plugin's directory in the release tree; its plugin id is `semctx`, not this name. */
const CLAUDE_PLUGIN_DIRECTORY = "claude-code";
const CODEX_PLUGIN_ID = `${CODEX_PLUGIN}@${MARKETPLACE_NAME}`;
const CLAUDE_PLUGIN_ID = `${CLAUDE_PLUGIN}@${MARKETPLACE_NAME}`;
const CODEX_SNAPSHOT_SEGMENTS = [".tmp", "marketplaces", MARKETPLACE_NAME] as const;
const CODEX_CACHE_SEGMENTS = ["plugins", "cache", MARKETPLACE_NAME, CODEX_PLUGIN] as const;

/**
 * The split runtime both plugins ship. Version equality proves nothing about these bytes, so they
 * are digested — the same standard `semctx install` already applies to the identical artifact.
 */
export const PLUGIN_RUNTIME_BUNDLES = [
  "semctx-index-worker.js",
  "semctx-mcp.js",
  "semctx-shared.js",
  "semctx.js",
] as const;

/** A plugin version is a semver token; anything else must never reach a filesystem path. */
const VERSION_SEGMENT = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * Drop C0/C1 controls, which a hostile host could use to repaint a terminal line. Written as an
 * explicit codepoint filter rather than a regex: the character class would itself have to embed
 * the control characters it removes.
 */
function stripControlCharacters(value: string): string {
  let output = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
    // Bidi embedding, override and isolate marks reorder rendered text without changing bytes,
    // so a hostile host could display a verdict the report does not contain.
    if (code >= 0x200e && code <= 0x200f) continue;
    if (code >= 0x202a && code <= 0x202e) continue;
    if (code >= 0x2066 && code <= 0x2069) continue;
    output += character;
  }
  return output;
}

/** Query/fragment keys whose value is a secret whenever a host echoes a URL back at us. */
const SECRET_PARAMETER = /\b(token|access[_-]?token|api[_-]?key|password|secret|auth|signature|sig|key)\b/i;

/**
 * Redact secret-bearing URL parameters. A private marketplace configured with a token puts that
 * token in the host inventory, and `--json` output is exactly what users paste into issues.
 */
function redactSecretParameters(value: string): string {
  const separator = value.search(/[?#]/);
  if (separator === -1) return value;
  const head = value.slice(0, separator);
  const marker = value.charAt(separator);
  const tail = value.slice(separator + 1);
  const redacted = tail
    .split(/([&;])/)
    .map((part) => {
      if (part === "&" || part === ";") return part;
      const equals = part.indexOf("=");
      if (equals === -1) return part;
      const name = part.slice(0, equals);
      return SECRET_PARAMETER.test(name) ? `${name}=REDACTED` : part;
    })
    .join("");
  return `${head}${marker}${redacted}`;
}

export type PluginDeliveryVerdict = "UP_TO_DATE" | "UPDATE_AVAILABLE" | "UNKNOWN";

export type PluginDeliveryHost = "codex" | "claude";

export const PLUGIN_DELIVERY_HOSTS: readonly PluginDeliveryHost[] = ["codex", "claude"];

/**
 * Where each host's artifacts live in the release tree. The two plugins ship the same split
 * runtime, but they ship *their own copy* of it: reading one and applying it to the other would
 * assert a cross-host equality instead of proving it.
 */
const RELEASE_PLUGIN: Record<PluginDeliveryHost, { directory: string; manifest: string }> = {
  codex: { directory: CODEX_PLUGIN, manifest: ".codex-plugin" },
  claude: { directory: CLAUDE_PLUGIN_DIRECTORY, manifest: ".claude-plugin" },
};

/**
 * Canonical reason codes. Every code either forbids a verdict outright (`UNKNOWN`) or names a
 * layer that has fallen behind (`UPDATE_AVAILABLE`); the two sets are disjoint and exhaustive.
 */
export type PluginDeliveryReason =
  | "HOST_NOT_DETECTED"
  | "HOST_QUERY_FAILED"
  | "HOST_QUERY_TIMEOUT"
  | "HOST_OUTPUT_TOO_LARGE"
  | "HOST_OUTPUT_MALFORMED"
  | "HOST_PATH_REJECTED"
  | "MARKETPLACE_NOT_CONFIGURED"
  | "MARKETPLACE_SOURCE_MISMATCH"
  | "MARKETPLACE_REF_UNKNOWN"
  | "MARKETPLACE_REF_UNEXPECTED"
  | "SNAPSHOT_UNREADABLE"
  | "SNAPSHOT_COMMIT_UNKNOWN"
  | "SNAPSHOT_VERSION_UNKNOWN"
  | "SNAPSHOT_BEHIND_PUBLIC_RELEASE"
  | "SNAPSHOT_CONTENT_UNPROVEN"
  | "SNAPSHOT_CONTENT_DIVERGED"
  | "PLUGIN_NOT_INSTALLED"
  | "PLUGIN_DISABLED"
  | "INSTALLED_CACHE_UNREADABLE"
  | "INSTALLED_CACHE_BEHIND_SNAPSHOT"
  | "INSTALLED_CACHE_NOT_PUBLIC_RELEASE"
  | "INSTALLED_CACHE_CONTENT_UNPROVEN"
  | "INSTALLED_CACHE_CONTENT_DIVERGED"
  | "PUBLIC_RELEASE_UNRESOLVED"
  | "SESSION_VERSION_UNOBSERVABLE"
  | "SESSION_BEHIND_INSTALLED_CACHE";

/** Reasons that make the state unprovable. Any one of them forces `UNKNOWN`. */
const UNPROVABLE_REASONS: ReadonlySet<PluginDeliveryReason> = new Set([
  "HOST_NOT_DETECTED",
  "HOST_QUERY_FAILED",
  "HOST_QUERY_TIMEOUT",
  "HOST_OUTPUT_TOO_LARGE",
  "HOST_OUTPUT_MALFORMED",
  "HOST_PATH_REJECTED",
  "MARKETPLACE_NOT_CONFIGURED",
  "MARKETPLACE_SOURCE_MISMATCH",
  "MARKETPLACE_REF_UNKNOWN",
  "SNAPSHOT_UNREADABLE",
  "SNAPSHOT_COMMIT_UNKNOWN",
  "SNAPSHOT_VERSION_UNKNOWN",
  "SNAPSHOT_CONTENT_UNPROVEN",
  "PLUGIN_NOT_INSTALLED",
  "INSTALLED_CACHE_UNREADABLE",
  "INSTALLED_CACHE_CONTENT_UNPROVEN",
  "PUBLIC_RELEASE_UNRESOLVED",
  "SESSION_VERSION_UNOBSERVABLE",
]);

/**
 * How much authority a public-release claim carries. Only an attestation of the channel itself can
 * license `UP_TO_DATE`; anything else — including a value this build does not recognise — is
 * informative at best and fails closed.
 */
export type PublicReleaseAuthority =
  /** The public channel itself was consulted without mutation and under explicit time/acceptance caps. */
  | "attested-release"
  /** An already-fetched local ref. It proves what was fetched, not that nothing newer exists. */
  | "local-mirror"
  /** No usable evidence at all. */
  | "absent";

const PUBLIC_RELEASE_AUTHORITIES: ReadonlySet<string> = new Set<PublicReleaseAuthority>([
  "attested-release",
  "local-mirror",
  "absent",
]);

/** Deterministic ceilings so no probe can hang the diagnostic or flood it. */
export const PLUGIN_DELIVERY_QUERY_TIMEOUT_MS = 5_000;
/**
 * Attestation crosses the network exactly once, so it gets its own budget — larger than a local
 * host query, still deterministic, and still a hard ceiling rather than a hint.
 */
export const PLUGIN_DELIVERY_ATTESTATION_TIMEOUT_MS = 30_000;
/** Host inventories are small JSON documents; anything larger is refused rather than parsed. */
export const PLUGIN_DELIVERY_MAX_HOST_OUTPUT_BYTES = 4 * 1024 * 1024;
/** Release artifacts are read from Git objects and legitimately reach several megabytes. */
export const PLUGIN_DELIVERY_MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
/**
 * How large the attestation's throwaway store may be and still be trusted.
 *
 * `--depth=1` bounds ancestry, not bytes, and no Git transport option caps a pack, so this is an
 * *acceptance* ceiling rather than a transfer one: the store is measured after the fetch and
 * refused before any witness is read from it. Measured on 2026-08-11, a real `stable` store is
 * about 2.9 MB — a measurement, not an invariant, and not a promise about future releases.
 */
export const PLUGIN_DELIVERY_MAX_STORE_BYTES = 256 * 1024 * 1024;
/** A plugin or package manifest is a small JSON document; a larger file is refused, not read. */
export const PLUGIN_DELIVERY_MAX_MANIFEST_BYTES = 1024 * 1024;
/** A runtime bundle is a few megabytes; the ceiling is checked before a byte of it is allocated. */
export const PLUGIN_DELIVERY_MAX_BUNDLE_BYTES = 16 * 1024 * 1024;

export interface PluginDeliveryQueryLimits {
  timeoutMs: number;
  /**
   * Total output budget across both streams. The runner enforces it as `maxBytes / 2` per stream,
   * because the underlying spawn applies its ceiling to stdout and stderr *separately*; halving is
   * what makes the total an actual bound rather than a claim contradicted by a two-stream flood.
   */
  maxBytes: number;
  /**
   * Remove every inherited Git-influencing variable and non-system TLS trust override before
   * applying `env`.
   *
   * Enumerating the dangerous names is not enough — `GIT_CONFIG_PARAMETERS`, `GIT_SSL_NO_VERIFY`,
   * `GIT_COMMON_DIR`, `GIT_EXEC_PATH` and the whole `GIT_TRACE*` family each redirect
   * configuration, transport, object lookup or output, and the set grows with Git itself. The
   * policy is therefore subtractive: drop the namespace and caller-selected CA/log outputs, then
   * reintroduce exactly what a lane needs.
   */
  hermeticGit?: boolean;
  /** Values layered on after inheritance/stripping; `null` removes a variable. */
  env?: Readonly<Record<string, string | null>>;
}

export interface PluginDeliveryQueryOutcome {
  code: number;
  out: string;
  err: string;
  /** Raw stdout, when the runner can supply it; digests prefer bytes over a decoded string. */
  bytes?: Uint8Array | null;
  /** The probe exceeded its deterministic time budget. */
  timedOut?: boolean;
  /** The probe exceeded its deterministic output budget; `out` must not be trusted. */
  truncated?: boolean;
}

/** What a marketplace snapshot directory declares about the source it was resolved from. */
export interface MarketplaceSnapshotProbe {
  /** Commit the host checked out for this marketplace; `null` when it cannot be proven. */
  commit: string | null;
  /** Ref the marketplace tracks, e.g. `stable`. */
  ref: string | null;
  /** Git source the marketplace was resolved from. */
  source: string | null;
  /** Plugin manifest version inside the snapshot. */
  version: string | null;
  /** SHA-256 per runtime bundle basename; `null` for any bundle that is not provably readable. */
  bundles: Record<string, string | null>;
}

/** What the executed cache entry declares and contains. */
export interface InstalledPayloadProbe {
  version: string | null;
  bundles: Record<string, string | null>;
}

/**
 * Immutable SHA-256 bundle witnesses, per host plugin, read from one release commit.
 *
 * Both plugins ship the same split runtime, so the two records must agree — but that agreement is
 * *proven* here, not assumed: a release whose two host payloads differ is not one coherent artifact
 * and licenses nothing.
 */
export type PublicReleaseBundleWitnesses = Record<PluginDeliveryHost, Record<string, string | null>>;

/** The public `stable` release, resolved without mutating the inspected project. */
export interface PublicReleaseProbe {
  /** Typed provenance. An unrecognised value is treated as no authority at all. */
  authority: PublicReleaseAuthority;
  status: "resolved" | "unknown";
  version: string | null;
  commit: string | null;
  source: string | null;
  reasons: readonly string[];
  /** Per-host immutable bundle witnesses read from the attested release commit. */
  bundles: PublicReleaseBundleWitnesses | null;
}

/** The checkout this diagnostic runs from. Informative: it never confers delivery freshness. */
export interface RepositoryChannelProbe {
  commit: string | null;
  originIsSemctx: boolean;
}

/**
 * The version a running session actually loaded. Reported only when the host exposes it; it is
 * never inferred from the installed cache, because a session keeps what it started with.
 */
export interface SessionVersionProbe {
  status: "observed" | "unknown";
  version: string | null;
  reason: string | null;
}

export interface PluginDeliveryDependencies {
  /**
   * Read-only host query, bounded in duration and output volume. Mutating commands are never
   * issued through this seam.
   */
  runQuery(
    command: readonly string[],
    cwd: string,
    limits?: PluginDeliveryQueryLimits,
  ): PluginDeliveryQueryOutcome;
  readMarketplaceSnapshot(host: PluginDeliveryHost, root: string): MarketplaceSnapshotProbe | null;
  readInstalledPayload(host: PluginDeliveryHost, path: string): InstalledPayloadProbe | null;
  readRepositoryChannel(repositoryRoot: string): RepositoryChannelProbe;
  resolvePublicRelease(repositoryRoot: string): PublicReleaseProbe;
  observeSessionVersion(host: PluginDeliveryHost): SessionVersionProbe;
  /** Absolute home each host owns. Every host-supplied path must resolve inside it. */
  resolveHostHome(host: PluginDeliveryHost): string | null;
}

/**
 * Which hosts the report covers. `auto` inspects whatever is installed and omits the rest; naming
 * a host makes it part of the answer, so its absence keeps the aggregate unknown instead of
 * quietly shrinking the question.
 */
export type PluginDeliveryScope = "auto" | PluginDeliveryHost | "all";

export interface PluginDeliveryCommand {
  repositoryRoot: string;
  /** Version of the running semctx build; the repository channel, not the released one. */
  version: string;
  scope?: PluginDeliveryScope;
  /** Explicit host list; equivalent to naming those hosts, so an absent one stays unknown. */
  hosts?: readonly PluginDeliveryHost[];
  /**
   * Ask the configured remote what the public `stable` ref points at right now. This is the only
   * part of the diagnostic that leaves the machine; it is non-mutating, opt-in, time-bounded and
   * acceptance-capped, and it degrades to an explicit `absent` authority offline.
   */
  attest?: boolean;
}

function requestedHosts(command: PluginDeliveryCommand): readonly PluginDeliveryHost[] {
  if (command.hosts !== undefined) return command.hosts;
  const scope = command.scope ?? "auto";
  if (scope === "codex" || scope === "claude") return [scope];
  return PLUGIN_DELIVERY_HOSTS;
}

/** Only `auto` may drop a host it did not find; every explicit selection keeps it in the answer. */
function omitsUndetectedHosts(command: PluginDeliveryCommand): boolean {
  return command.hosts === undefined && (command.scope ?? "auto") === "auto";
}

export interface HostMarketplaceStateV1 {
  name: string;
  configured: boolean;
  source: string | null;
  ref: string | null;
  matchesSemctx: boolean | null;
}

export interface HostSnapshotStateV1 {
  commit: string | null;
  version: string | null;
  path: string | null;
}

export interface HostInstalledStateV1 {
  version: string | null;
  path: string | null;
  installed: boolean | null;
  enabled: boolean | null;
  /** Whether every runtime bundle in the cache digests equal to the snapshot. `null` if unproven. */
  contentMatchesSnapshot: boolean | null;
  /** Whether every cache bundle digest equals the immutable public-release witness. */
  contentMatchesPublicRelease: boolean | null;
}

export interface HostSessionStateV1 {
  status: "observed" | "unknown";
  version: string | null;
  reason: string | null;
}

export interface HostPluginDeliveryV1 {
  requested: boolean;
  detected: boolean;
  marketplace: HostMarketplaceStateV1;
  snapshot: HostSnapshotStateV1;
  installed: HostInstalledStateV1;
  session: HostSessionStateV1;
  /** `null` whenever the state is unprovable — never a default of `false`. */
  updateAvailable: boolean | null;
  /**
   * Delivery alone: is the executed cache the public `stable` release? Kept separate from
   * `verdict` the way index health keeps coverage separate from freshness — an unobservable
   * session never upgrades this, and this never upgrades `verdict`.
   */
  delivery: PluginDeliveryVerdict;
  /** Delivery and activation together. Never `UP_TO_DATE` while a session gap is unproven. */
  verdict: PluginDeliveryVerdict;
  reasons: PluginDeliveryReason[];
  /** Exact supported convergence commands, in order. Empty when nothing is required. */
  convergence: string[][];
  /** How a running session picks up an installed version, when that is required. */
  activation: string | null;
}

export interface RepositoryChannelV1 {
  version: string;
  commit: string | null;
  originIsSemctx: boolean;
  /** `false` when the checkout is not at the released commit; `null` when unresolvable. */
  matchesPublicRelease: boolean | null;
  /** Structural statement of the invariant: repository state is never delivery evidence. */
  conveysDelivery: false;
}

export interface PublicReleaseV1 {
  /** Typed provenance; only `attested-release` can license a converged delivery verdict. */
  authority: PublicReleaseAuthority | "unrecognised";
  status: "resolved" | "unknown";
  version: string | null;
  commit: string | null;
  source: string | null;
  reasons: string[];
}

export interface PluginDeliveryReportV1 {
  schemaVersion: typeof PLUGIN_DELIVERY_SCHEMA_VERSION;
  kind: "plugin_delivery_status";
  /** Delivery and activation together; `UP_TO_DATE` only when nothing is left to do. */
  verdict: PluginDeliveryVerdict;
  /** Delivery alone: whether every observed host executes the public `stable` release. */
  delivery: PluginDeliveryVerdict;
  repository: RepositoryChannelV1;
  publicRelease: PublicReleaseV1;
  hosts: Record<PluginDeliveryHost, HostPluginDeliveryV1>;
  reasons: PluginDeliveryReason[];
  next: string[];
}

/** The exact supported convergence path per host, mirroring what `semctx install` performs. */
const CONVERGENCE: Record<PluginDeliveryHost, readonly string[][]> = {
  codex: [
    ["codex", "plugin", "marketplace", "upgrade", MARKETPLACE_NAME, "--json"],
    ["codex", "plugin", "add", CODEX_PLUGIN_ID, "--json"],
  ],
  claude: [
    ["claude", "plugin", "marketplace", "update", MARKETPLACE_NAME],
    ["claude", "plugin", "update", CLAUDE_PLUGIN_ID, "--scope", "user"],
  ],
};

/** Only Claude documents a plugin-level enable; Codex has none, so none is invented. */
const ENABLE_COMMAND: Partial<Record<PluginDeliveryHost, readonly string[]>> = {
  claude: ["claude", "plugin", "enable", CLAUDE_PLUGIN_ID, "--scope", "user"],
};

const ACTIVATION: Record<PluginDeliveryHost, string> = {
  codex:
    "open a new Codex task: a running task keeps the plugin version it started with, so only a new"
    + " task resolves the installed one",
  claude:
    "run /reload-plugins in the active Claude Code session, and restart Claude Code if the reload"
    + " reports an error or the plugin stays unavailable",
};

function parseJsonValue(out: string): unknown {
  try {
    return JSON.parse(out);
  } catch {
    return undefined;
  }
}

/** Host JSON is untrusted: drop every entry that is not a plain object. */
function objectEntries(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
      (item): item is Record<string, unknown> =>
        item !== null && typeof item === "object" && !Array.isArray(item),
    )
    : [];
}

/**
 * Host output is echoed into a terminal and into JSON users paste into issues. Strip control
 * characters, which a hostile host could use to repaint a line and forge a verdict, and strip
 * URL userinfo, which is how a private marketplace's token would otherwise leak.
 */
function safeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const stripped = stripControlCharacters(value).trim();
  if (stripped.length === 0) return null;
  const withoutUserInfo = stripped.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/@]*@/, "$1");
  return redactSecretParameters(withoutUserInfo);
}

function normalizeGitSource(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .trim()
    .toLowerCase()
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/, "$1")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
}

function isSemctxSource(value: unknown): boolean {
  const normalized = normalizeGitSource(value);
  return normalized === "hoklims/semctx" || normalized === "https://github.com/hoklims/semctx";
}

/**
 * A UNC or Win32 device path handed back by a host is not a local read: touching
 * `\\<host>\share` makes Windows open an SMB connection, which is network egress from a product
 * path, a multi-second stall, and an NTLM authentication attempt against whoever answers. Reject
 * the shape before any filesystem call can see it.
 */
export function isLocalFilesystemPath(candidate: string): boolean {
  if (!isAbsolute(candidate)) return false;
  return !/^[\\/]{2}/.test(candidate) && !candidate.includes("\0");
}

/** `candidate` must be `root` itself or strictly inside it, comparing resolved forms. */
function isWithin(candidate: string, root: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const normalize = (value: string): string =>
    process.platform === "win32" ? value.toLowerCase() : value;
  const normalizedRoot = normalize(resolvedRoot);
  const normalizedCandidate = normalize(resolvedCandidate);
  return normalizedCandidate === normalizedRoot
    || normalizedCandidate.startsWith(normalizedRoot.endsWith(sep) ? normalizedRoot : normalizedRoot + sep);
}

/** Compare against a trusted root's lexical and canonical spellings without accepting another tree. */
function isWithinTrustedRoot(candidate: string, root: string): boolean {
  if (isWithin(candidate, root)) return true;
  try {
    return isWithin(candidate, realpathSync.native(resolve(root)));
  } catch {
    return false;
  }
}

/**
 * Accept a host-supplied path only when it is a local absolute path confined to that host's own
 * home. The host reports these paths, but a compromised or misconfigured host must not be able to
 * steer this diagnostic at an arbitrary tree — the whole report's credibility rests on them.
 */
function acceptHostPath(candidate: string | null, home: string | null): string | null {
  if (candidate === null || home === null) return null;
  if (!isLocalFilesystemPath(candidate) || !isLocalFilesystemPath(home)) return null;

  const resolvedCandidate = resolve(candidate);
  const resolvedHome = resolve(home);
  // Dependency-injected tests use virtual paths. Real host paths, however, must be canonicalized so
  // a junction or symlink cannot escape the lexical home after this check. Probe only the trusted
  // home first; never touch the complete untrusted candidate to decide whether it exists.
  try {
    lstatSync(resolvedHome);
  } catch {
    return isWithin(resolvedCandidate, resolvedHome) ? resolvedCandidate : null;
  }
  return walkExistingPathWithoutLinks(resolvedCandidate, resolvedHome, "any")?.path ?? null;
}

/**
 * Derive the cache entry Codex executes from the marketplace root the host reported, anchored to
 * the resolved Codex home. Returns `null` rather than guessing: an unexpected layout, an unsafe
 * version segment, or a root outside that home must leave the caller fail-closed, because this
 * path is what we would otherwise trust as proof.
 */
export function codexCacheEntryFromMarketplaceRoot(
  marketplaceRoot: string,
  version: string,
  home: string | null = null,
): string | null {
  if (!VERSION_SEGMENT.test(version) || !isLocalFilesystemPath(marketplaceRoot)) return null;
  const resolvedRoot = resolve(marketplaceRoot);
  const segments = resolvedRoot.split(/[\\/]/).filter((part) => part.length > 0);
  const tail = segments.slice(-CODEX_SNAPSHOT_SEGMENTS.length);
  if (tail.length !== CODEX_SNAPSHOT_SEGMENTS.length) return null;
  for (let index = 0; index < CODEX_SNAPSHOT_SEGMENTS.length; index += 1) {
    if (tail[index] !== CODEX_SNAPSHOT_SEGMENTS[index]) return null;
  }
  const derivedHome = resolve(resolvedRoot, "..", "..", "..");
  // The snapshot root must sit under the Codex home we resolved independently, not merely end in
  // the right three segments: a look-alike tail anywhere on disk would otherwise be accepted.
  if (home !== null && !isWithinTrustedRoot(resolvedRoot, home)) return null;
  if (home !== null && !isWithinTrustedRoot(derivedHome, home)) return null;
  const root = resolve(join(derivedHome, ...CODEX_CACHE_SEGMENTS));
  const entry = resolve(join(root, version));
  return entry.startsWith(root + sep) ? entry : null;
}

interface HostQueries {
  marketplaces: unknown;
  plugins: unknown;
}

/** One host's raw state, or the reason it could not be read. */
/**
 * A probe that hit its time or volume ceiling proves nothing, and its partial output must not be
 * parsed. Both map to a stable reason so the verdict is reproducible rather than timing-dependent.
 */
function boundedFailure(outcome: PluginDeliveryQueryOutcome): PluginDeliveryReason | null {
  if (outcome.timedOut === true) return "HOST_QUERY_TIMEOUT";
  if (outcome.truncated === true) return "HOST_OUTPUT_TOO_LARGE";
  return null;
}

function readHostQueries(
  host: PluginDeliveryHost,
  cwd: string,
  dependencies: PluginDeliveryDependencies,
): HostQueries | PluginDeliveryReason {
  const limits = { timeoutMs: PLUGIN_DELIVERY_QUERY_TIMEOUT_MS, maxBytes: PLUGIN_DELIVERY_MAX_HOST_OUTPUT_BYTES };
  const marketplacesResult = dependencies.runQuery(
    [host, "plugin", "marketplace", "list", "--json"],
    cwd,
    limits,
  );
  const marketplacesBound = boundedFailure(marketplacesResult);
  if (marketplacesBound !== null) return marketplacesBound;
  if (marketplacesResult.code !== 0) return "HOST_QUERY_FAILED";
  const pluginsResult = dependencies.runQuery([host, "plugin", "list", "--json"], cwd, limits);
  const pluginsBound = boundedFailure(pluginsResult);
  if (pluginsBound !== null) return pluginsBound;
  if (pluginsResult.code !== 0) return "HOST_QUERY_FAILED";

  const marketplaces = parseJsonValue(marketplacesResult.out);
  const plugins = parseJsonValue(pluginsResult.out);
  if (marketplaces === undefined || plugins === undefined) return "HOST_OUTPUT_MALFORMED";

  const marketplaceList = host === "codex"
    ? (marketplaces as { marketplaces?: unknown } | null)?.marketplaces
    : marketplaces;
  const pluginList = host === "codex"
    ? (plugins as { installed?: unknown } | null)?.installed
    : plugins;
  if (!Array.isArray(marketplaceList) || !Array.isArray(pluginList)) return "HOST_OUTPUT_MALFORMED";

  return { marketplaces: marketplaceList, plugins: pluginList };
}

function emptyHost(requested: boolean, detected: boolean): HostPluginDeliveryV1 {
  return {
    requested,
    detected,
    marketplace: { name: MARKETPLACE_NAME, configured: false, source: null, ref: null, matchesSemctx: null },
    snapshot: { commit: null, version: null, path: null },
    installed: {
      version: null,
      path: null,
      installed: null,
      enabled: null,
      contentMatchesSnapshot: null,
      contentMatchesPublicRelease: null,
    },
    session: { status: "unknown", version: null, reason: null },
    updateAvailable: null,
    delivery: "UNKNOWN",
    verdict: "UNKNOWN",
    reasons: [],
    convergence: [],
    activation: null,
  };
}

function verdictFor(reasons: readonly PluginDeliveryReason[]): PluginDeliveryVerdict {
  if (reasons.some((reason) => UNPROVABLE_REASONS.has(reason))) return "UNKNOWN";
  return reasons.length > 0 ? "UPDATE_AVAILABLE" : "UP_TO_DATE";
}

function sortedUnique(reasons: readonly PluginDeliveryReason[]): PluginDeliveryReason[] {
  return [...new Set(reasons)].sort();
}

/** Reasons about what a running session loaded, as opposed to what was delivered to disk. */
function isSessionReason(reason: PluginDeliveryReason): boolean {
  return reason === "SESSION_VERSION_UNOBSERVABLE" || reason === "SESSION_BEHIND_INSTALLED_CACHE";
}

/**
 * Compare the executed cache against the approved snapshot byte-for-byte, per runtime bundle.
 * Version equality is deliberately not enough: a locked cache entry keeps its old bytes under an
 * unchanged version-keyed directory, which is exactly the state `semctx install` had to defend
 * against, so the digests decide.
 */
function compareBundleRecords(
  candidate: Record<string, string | null>,
  expected: Record<string, string | null>,
): "match" | "diverged" | "unproven" {
  let diverged = false;
  for (const name of PLUGIN_RUNTIME_BUNDLES) {
    const actual = candidate[name] ?? null;
    const wanted = expected[name] ?? null;
    if (actual === null || wanted === null) return "unproven";
    if (actual !== wanted) diverged = true;
  }
  return diverged ? "diverged" : "match";
}

function evaluateHost(
  host: PluginDeliveryHost,
  command: PluginDeliveryCommand,
  publicRelease: PublicReleaseV1,
  publicReleaseBundles: Record<string, string | null> | null,
  dependencies: PluginDeliveryDependencies,
): HostPluginDeliveryV1 {
  const detection = dependencies.runQuery([host, "--version"], command.repositoryRoot, {
    timeoutMs: PLUGIN_DELIVERY_QUERY_TIMEOUT_MS,
    maxBytes: PLUGIN_DELIVERY_MAX_HOST_OUTPUT_BYTES,
  });
  const detectionBound = boundedFailure(detection);
  if (detectionBound !== null) {
    const report = emptyHost(true, true);
    report.reasons = [detectionBound];
    return report;
  }
  if (detection.code !== 0) {
    const report = emptyHost(true, false);
    report.reasons = ["HOST_NOT_DETECTED"];
    return report;
  }

  const report = emptyHost(true, true);
  const reasons: PluginDeliveryReason[] = [];
  if (publicRelease.status !== "resolved") reasons.push("PUBLIC_RELEASE_UNRESOLVED");

  const queries = readHostQueries(host, command.repositoryRoot, dependencies);
  if (typeof queries === "string") {
    report.reasons = sortedUnique([...reasons, queries]);
    report.verdict = "UNKNOWN";
    return report;
  }
  const home = dependencies.resolveHostHome(host);

  // --- Layer 3: the marketplace the host is configured against, and the snapshot it approved. ---
  const marketplace = objectEntries(queries.marketplaces).find(
    (entry) => entry["name"] === MARKETPLACE_NAME,
  );
  if (marketplace === undefined) {
    report.reasons = sortedUnique([...reasons, "MARKETPLACE_NOT_CONFIGURED"]);
    report.verdict = "UNKNOWN";
    return report;
  }
  report.marketplace.configured = true;

  const hostSource = host === "codex"
    ? safeText((marketplace["marketplaceSource"] as { source?: unknown } | undefined)?.source)
    : safeText(marketplace["repo"]);
  report.marketplace.source = hostSource;
  report.marketplace.matchesSemctx = isSemctxSource(hostSource);
  if (report.marketplace.matchesSemctx !== true) reasons.push("MARKETPLACE_SOURCE_MISMATCH");

  const reportedRoot = host === "codex"
    ? safeText(marketplace["root"])
    : safeText(marketplace["installLocation"]);
  const marketplaceRoot = acceptHostPath(reportedRoot, home);
  if (reportedRoot !== null && marketplaceRoot === null) reasons.push("HOST_PATH_REJECTED");
  report.snapshot.path = marketplaceRoot;

  const snapshot = marketplaceRoot === null
    ? null
    : dependencies.readMarketplaceSnapshot(host, marketplaceRoot);
  if (snapshot === null) {
    reasons.push("SNAPSHOT_UNREADABLE");
  } else {
    report.snapshot.commit = safeText(snapshot.commit);
    report.snapshot.version = safeText(snapshot.version);
    if (report.snapshot.commit === null) reasons.push("SNAPSHOT_COMMIT_UNKNOWN");
    if (report.snapshot.version === null) reasons.push("SNAPSHOT_VERSION_UNKNOWN");
  }

  // Claude reports the tracked ref directly; Codex records it in the snapshot install metadata.
  const ref = safeText(marketplace["ref"]) ?? safeText(snapshot?.ref) ?? null;
  report.marketplace.ref = ref;
  if (ref === null) reasons.push("MARKETPLACE_REF_UNKNOWN");
  else if (ref !== PLUGIN_DELIVERY_RELEASE_REF) reasons.push("MARKETPLACE_REF_UNEXPECTED");

  // --- Layer 4: the versioned cache the host actually executes. ---
  const pluginId = host === "codex" ? CODEX_PLUGIN_ID : CLAUDE_PLUGIN_ID;
  const installedEntry = objectEntries(queries.plugins).find((entry) =>
    host === "codex"
      ? entry["pluginId"] === pluginId
      : entry["id"] === pluginId && entry["scope"] === "user");

  const present = host === "codex"
    ? installedEntry !== undefined && installedEntry["installed"] === true
    : installedEntry !== undefined;
  if (!present) {
    report.reasons = sortedUnique([...reasons, "PLUGIN_NOT_INSTALLED"]);
    report.verdict = "UNKNOWN";
    return report;
  }

  report.installed.installed = true;
  report.installed.enabled = installedEntry?.["enabled"] === true;
  if (report.installed.enabled !== true) reasons.push("PLUGIN_DISABLED");

  const hostVersion = safeText(installedEntry?.["version"]);
  // `source.path` is the approved marketplace snapshot, never the executed cache entry.
  const reportedCachePath = host === "codex"
    ? (marketplaceRoot === null || hostVersion === null
      ? null
      : codexCacheEntryFromMarketplaceRoot(marketplaceRoot, hostVersion, home))
    : safeText(installedEntry?.["installPath"]);
  const cachePath = acceptHostPath(reportedCachePath, home);
  if (reportedCachePath !== null && cachePath === null) reasons.push("HOST_PATH_REJECTED");
  report.installed.path = cachePath;

  const payload = cachePath === null ? null : dependencies.readInstalledPayload(host, cachePath);
  const cacheVersion = safeText(payload?.version);
  if (payload === null || cacheVersion === null) {
    report.reasons = sortedUnique([...reasons, "INSTALLED_CACHE_UNREADABLE"]);
    report.verdict = "UNKNOWN";
    return report;
  }
  report.installed.version = cacheVersion;

  if (report.snapshot.version !== null && cacheVersion !== report.snapshot.version) {
    reasons.push("INSTALLED_CACHE_BEHIND_SNAPSHOT");
  }

  // Content, not version: two different payloads can share a version-keyed directory name.
  if (snapshot === null) {
    reasons.push("INSTALLED_CACHE_CONTENT_UNPROVEN");
  } else {
    const comparison = compareBundleRecords(payload.bundles, snapshot.bundles);
    report.installed.contentMatchesSnapshot = comparison === "unproven" ? null : comparison === "match";
    if (comparison === "unproven") reasons.push("INSTALLED_CACHE_CONTENT_UNPROVEN");
    if (comparison === "diverged") reasons.push("INSTALLED_CACHE_CONTENT_DIVERGED");
  }

  // --- Layer 2: the public release. Only this may license `UP_TO_DATE`. ---
  if (publicRelease.status === "resolved") {
    if (publicRelease.commit !== null
      && report.snapshot.commit !== null
      && report.snapshot.commit !== publicRelease.commit) {
      reasons.push("SNAPSHOT_BEHIND_PUBLIC_RELEASE");
    }
    if (publicRelease.version !== null && cacheVersion !== publicRelease.version) {
      reasons.push("INSTALLED_CACHE_NOT_PUBLIC_RELEASE");
    }
    if (publicReleaseBundles === null) {
      reasons.push("INSTALLED_CACHE_CONTENT_UNPROVEN");
    } else {
      const snapshotComparison = snapshot === null
        ? "unproven"
        : compareBundleRecords(snapshot.bundles, publicReleaseBundles);
      if (snapshotComparison === "unproven") reasons.push("SNAPSHOT_CONTENT_UNPROVEN");
      if (snapshotComparison === "diverged") reasons.push("SNAPSHOT_CONTENT_DIVERGED");

      const cacheComparison = compareBundleRecords(payload.bundles, publicReleaseBundles);
      report.installed.contentMatchesPublicRelease = cacheComparison === "unproven"
        ? null
        : cacheComparison === "match";
      if (cacheComparison === "unproven") reasons.push("INSTALLED_CACHE_CONTENT_UNPROVEN");
      if (cacheComparison === "diverged") reasons.push("INSTALLED_CACHE_NOT_PUBLIC_RELEASE");
    }
  }

  // --- Layer 5: what a running session loaded. Never inferred from the cache. ---
  const session = dependencies.observeSessionVersion(host);
  report.session = {
    status: session.status,
    version: safeText(session.version),
    reason: safeText(session.reason),
  };
  if (report.session.status !== "observed" || report.session.version === null) {
    reasons.push("SESSION_VERSION_UNOBSERVABLE");
  } else if (report.session.version !== cacheVersion) {
    reasons.push("SESSION_BEHIND_INSTALLED_CACHE");
  }

  report.reasons = sortedUnique(reasons);
  report.verdict = verdictFor(report.reasons);
  const deliveryReasons = report.reasons.filter((reason) => !isSessionReason(reason));
  report.delivery = verdictFor(deliveryReasons);
  report.updateAvailable = report.delivery === "UNKNOWN" ? null : report.delivery === "UPDATE_AVAILABLE";
  // An install or update command is only ever emitted for a *proven* divergence. Uncertainty about
  // the delivery authority proposes nothing to install: that is the fail-closed half.
  if (report.delivery === "UPDATE_AVAILABLE") {
    const enable = ENABLE_COMMAND[host];
    report.convergence = [
      ...CONVERGENCE[host].map((entry) => [...entry]),
      ...(report.installed.enabled === false && enable !== undefined ? [[...enable]] : []),
    ];
  }
  // Activation is an independent dimension, and it is required in two unrelated situations: a
  // convergence would replace the cache under a session that keeps what it started with, and an
  // unproven session already needs the action that makes its version observable. The second is the
  // one the delivery authority must not be able to suppress — whether `stable` could be attested
  // says nothing about how a running session picks up what is already on disk. Reached only after
  // the session layer was probed; a host that failed earlier returned above and proposes nothing.
  if (report.delivery === "UPDATE_AVAILABLE" || report.reasons.some(isSessionReason)) {
    report.activation = ACTIVATION[host];
  }
  return report;
}

function aggregate(
  hosts: readonly HostPluginDeliveryV1[],
  dimension: "verdict" | "delivery",
): PluginDeliveryVerdict {
  const requested = hosts.filter((host) => host.requested);
  if (requested.length === 0) return "UNKNOWN";
  if (requested.some((host) => host[dimension] === "UNKNOWN")) return "UNKNOWN";
  if (requested.some((host) => host[dimension] === "UPDATE_AVAILABLE")) return "UPDATE_AVAILABLE";
  return "UP_TO_DATE";
}

function nextSteps(
  report: Omit<PluginDeliveryReportV1, "next">,
): string[] {
  const next: string[] = [];
  if (report.publicRelease.source === "git-remote-tracking-ref") {
    next.push(
      "the local origin/stable mirror is informational only; without an independent public-release"
        + " attestation, delivery stays unknown even when snapshot and cache match that mirror",
    );
  } else if (report.publicRelease.status !== "resolved") {
    next.push(
      "the public stable release could not be attested; treat delivery state as unknown",
    );
  }
  for (const host of PLUGIN_DELIVERY_HOSTS) {
    const state = report.hosts[host];
    const label = host === "codex" ? "Codex" : "Claude Code";
    if (!state.requested) continue;
    if (!state.detected) {
      next.push(`${label} is not available on PATH; its delivery state stays unknown`);
      continue;
    }
    for (const command of state.convergence) next.push(command.join(" "));
    if (state.activation !== null) next.push(state.activation);
  }
  if (report.repository.matchesPublicRelease === false) {
    next.push(
      "the checkout is not at the released commit; merging or building 'main' does not update an"
        + " installed plugin, which is delivered only through the public 'stable' channel",
    );
  }
  return next;
}

/**
 * Read-only cross-host plugin delivery status.
 *
 * `UP_TO_DATE` is reachable only when the executed cache is proven equal to the public `stable`
 * release — by version *and* by runtime-bundle digest — and a running session is proven to have
 * loaded it. Repository state never contributes.
 */
export function pluginDeliveryStatus(
  command: PluginDeliveryCommand,
  dependencies: Partial<PluginDeliveryDependencies> = {},
): PluginDeliveryReportV1 {
  // Every default is bound to the resolved query seam, so a test that injects `runQuery` observes
  // the Git reads too and the read-only guarantee is provable, not merely asserted.
  const runQuery = dependencies.runQuery ?? defaultRunQuery;
  const resolveHostHome = dependencies.resolveHostHome ?? defaultResolveHostHome;
  const resolved: PluginDeliveryDependencies = {
    runQuery,
    readMarketplaceSnapshot: dependencies.readMarketplaceSnapshot
      ?? ((host, root) => defaultReadMarketplaceSnapshot(host, root, runQuery)),
    readInstalledPayload: dependencies.readInstalledPayload ?? defaultReadInstalledPayload,
    readRepositoryChannel: dependencies.readRepositoryChannel
      ?? ((root) => defaultReadRepositoryChannel(root, runQuery)),
    resolvePublicRelease: dependencies.resolvePublicRelease
      ?? ((root) => defaultResolvePublicRelease(root, runQuery, command.attest === true, resolveHostHome)),
    observeSessionVersion: dependencies.observeSessionVersion ?? defaultObserveSessionVersion,
    resolveHostHome,
  };

  const requested = requestedHosts(command);
  const releaseProbe = resolved.resolvePublicRelease(command.repositoryRoot);
  // A release claim is authoritative only with version, commit, immutable bundle witnesses and an
  // attestation stronger than a local mirror. Demote partial or mirror-only answers once here so no
  // downstream comparison can be silently skipped while the envelope still reads as convergence.
  const witnesses = releaseProbe.bundles;
  const releaseBundlesComplete = witnesses !== null
    && PLUGIN_DELIVERY_HOSTS.every((host) =>
      PLUGIN_RUNTIME_BUNDLES.every((name) => witnesses[host]?.[name] != null));
  // Each host is compared against its own release payload, and the two payloads must be proven
  // equal. Without this the diagnostic would read one plugin's bundles and apply them to the other
  // host — asserting the cross-host equality it is supposed to establish.
  const releaseBundlesAgree = releaseBundlesComplete
    && PLUGIN_RUNTIME_BUNDLES.every((name) => witnesses?.codex[name] === witnesses?.claude[name]);
  // Provenance is typed, and a value this build does not recognise is not a provenance at all:
  // trusting an unknown label would be the exact fail-open this contract exists to prevent.
  const authorityRecognised = PUBLIC_RELEASE_AUTHORITIES.has(releaseProbe.authority);
  // Defence in depth: the typed authority decides, but a probe that simultaneously claims
  // attestation and names a local mirror is self-contradictory and is refused either way.
  const releaseAttested = authorityRecognised
    && releaseProbe.authority === "attested-release"
    && releaseProbe.source !== "git-remote-tracking-ref"
    && !releaseProbe.reasons.includes("PUBLIC_RELEASE_FROM_LOCAL_MIRROR");
  const releaseStructurallyComplete = releaseProbe.version !== null
    && releaseProbe.commit !== null
    && releaseBundlesComplete
    && releaseBundlesAgree;
  const releaseComplete = releaseProbe.status === "resolved"
    && releaseStructurallyComplete
    && releaseAttested;
  const structuralReasons = releaseProbe.status !== "resolved" ? [] : [
    ...(releaseProbe.version === null || releaseProbe.commit === null || !releaseBundlesComplete
      ? ["PUBLIC_RELEASE_INCOMPLETE"]
      : []),
    ...(releaseBundlesComplete && !releaseBundlesAgree
      ? ["PUBLIC_RELEASE_HOST_ARTIFACTS_DIVERGED"]
      : []),
  ];
  const publicRelease: PublicReleaseV1 = {
    authority: authorityRecognised ? releaseProbe.authority : "unrecognised",
    status: releaseComplete ? "resolved" : "unknown",
    version: releaseProbe.version,
    commit: releaseProbe.commit,
    source: releaseProbe.source,
    reasons: [
      ...releaseProbe.reasons,
      ...(!authorityRecognised ? ["PUBLIC_RELEASE_AUTHORITY_UNKNOWN"] : []),
      ...structuralReasons,
      ...(authorityRecognised && !releaseAttested ? ["PUBLIC_RELEASE_UNATTESTED"] : []),
    ].sort(),
  };
  const channel = resolved.readRepositoryChannel(command.repositoryRoot);

  // Each host receives its own witnesses, and only once the release is complete, attested and
  // internally consistent — an incomplete release hands over nothing rather than a partial record.
  const witnessesFor = (host: PluginDeliveryHost): Record<string, string | null> | null =>
    releaseComplete && witnesses !== null ? witnesses[host] : null;
  const hosts = {
    codex: requested.includes("codex")
      ? evaluateHost("codex", command, publicRelease, witnessesFor("codex"), resolved)
      : emptyHost(false, false),
    claude: requested.includes("claude")
      ? evaluateHost("claude", command, publicRelease, witnessesFor("claude"), resolved)
      : emptyHost(false, false),
  };

  // `auto` asks "what is installed here", so a host that is not installed is not part of the
  // question and is dropped. Naming a host asks about that host, so its absence stays unknown.
  if (omitsUndetectedHosts(command)) {
    for (const host of PLUGIN_DELIVERY_HOSTS) {
      if (hosts[host].requested && !hosts[host].detected) hosts[host] = emptyHost(false, false);
    }
  }

  // Every requested host contributes. A caller may omit a host explicitly, but an unavailable host
  // that was requested keeps the cross-host aggregate unknown rather than being silently erased.
  const contributing = [hosts.codex, hosts.claude].filter((host) => host.requested);
  const reasons = sortedUnique([
    ...(publicRelease.status === "resolved" ? [] : ["PUBLIC_RELEASE_UNRESOLVED" as const]),
    ...contributing.flatMap((host) => host.reasons),
  ]);

  const partial: Omit<PluginDeliveryReportV1, "next"> = {
    schemaVersion: PLUGIN_DELIVERY_SCHEMA_VERSION,
    kind: "plugin_delivery_status",
    verdict: aggregate([hosts.codex, hosts.claude], "verdict"),
    delivery: aggregate([hosts.codex, hosts.claude], "delivery"),
    repository: {
      version: command.version,
      commit: channel.commit,
      originIsSemctx: channel.originIsSemctx,
      matchesPublicRelease: channel.commit === null || publicRelease.commit === null
        ? null
        : channel.commit === publicRelease.commit,
      conveysDelivery: false,
    },
    publicRelease,
    hosts,
    reasons,
  };
  return { ...partial, next: nextSteps(partial) };
}

// --- Default, strictly read-only implementations -----------------------------------------------

type QueryRunner = PluginDeliveryDependencies["runQuery"];

function defaultRunQuery(
  command: readonly string[],
  cwd: string,
  limits: PluginDeliveryQueryLimits = {
    timeoutMs: PLUGIN_DELIVERY_QUERY_TIMEOUT_MS,
    maxBytes: PLUGIN_DELIVERY_MAX_HOST_OUTPUT_BYTES,
  },
): PluginDeliveryQueryOutcome {
  try {
    const result = Bun.spawnSync([...command], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      timeout: limits.timeoutMs,
      // Enforced *while* the child runs, so a flood is killed at the ceiling instead of being
      // buffered whole and inspected afterwards. The spawn applies this ceiling to each stream on
      // its own — measured, not assumed: 3 MiB on stdout plus 3 MiB on stderr survives a 4 MiB
      // `maxBuffer` — so the budget is halved to make the *total* an actual bound. Without the
      // halving, a probe splitting its flood across both streams would pass a limit that claims to
      // cover them.
      maxBuffer: perStreamCeiling(limits.maxBytes),
      ...environmentFor(limits),
    });
    const decoder = new TextDecoder();
    const ceiling = perStreamCeiling(limits.maxBytes);
    const bytes = result.stdout === undefined ? new Uint8Array() : new Uint8Array(result.stdout);
    const stderrBytes = result.stderr === undefined ? new Uint8Array() : new Uint8Array(result.stderr);
    // Both kills arrive as the same signal, so the cause is read from the reported reason rather
    // than guessed from `SIGTERM`, which would report every oversized probe as a timeout.
    const timedOut = result.exitedDueToTimeout === true;
    // A probe that outran its budget is refused whole: parsing a prefix would make the verdict a
    // function of how much arrived before the ceiling.
    // Bun reports a max-buffer exit inconsistently across platforms: Linux may return a buffer
    // exactly at the ceiling without setting `exitedDueToMaxBuffer`. Treat reaching the ceiling as
    // exhaustion on either stream. That makes the effective accepted maximum one byte lower, which
    // is the only fail-closed interpretation that remains portable.
    if (
      result.exitedDueToMaxBuffer === true
      || bytes.byteLength >= ceiling
      || stderrBytes.byteLength >= ceiling
    ) {
      return {
        code: result.exitCode ?? 1,
        out: "",
        err: "output exceeded the allowed size",
        bytes: null,
        truncated: true,
        timedOut,
      };
    }
    return {
      code: result.exitCode ?? 1,
      out: decoder.decode(bytes),
      err: decoder.decode(stderrBytes),
      bytes,
      timedOut,
    };
  } catch (cause) {
    return { code: 1, out: "", err: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** Half the declared total, so stdout and stderr together cannot exceed it. */
function perStreamCeiling(maxBytes: number): number {
  return Math.max(1, Math.floor(maxBytes / 2));
}

/**
 * Variables that steer Git without being configuration files.
 *
 * The whole `GIT_` namespace goes, plus the credential-manager namespace that reads `GCM_*`. This
 * is deliberately a namespace rule and not a list: `GIT_CONFIG_PARAMETERS` injects configuration,
 * `GIT_SSL_NO_VERIFY` disables certificate validation, `GIT_COMMON_DIR`/`GIT_DIR`/`GIT_WORK_TREE`
 * and the object/alternates variables redirect where objects are read, `GIT_EXEC_PATH` redirects
 * which helper binaries run, and `GIT_TRACE*` — `GIT_TRACE_PACKFILE` in particular — writes files
 * to a caller-chosen path. Enumerating today's dangerous names would leave tomorrow's uncovered.
 */
function isGitSteeringVariable(name: string): boolean {
  const upper = name.toUpperCase();
  return upper.startsWith("GIT_") || upper === "GIT" || upper.startsWith("GCM_");
}

/** libcurl/OpenSSL inputs that can replace the platform trust roots or write secrets outside scratch. */
const NETWORK_TRUST_STEERING_VARIABLES: ReadonlySet<string> = new Set([
  "CURL_CA_BUNDLE",
  "CURL_SSL_BACKEND",
  "QLOGDIR",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SSLKEYLOGFILE",
]);

function isNetworkTrustSteeringVariable(name: string): boolean {
  return NETWORK_TRUST_STEERING_VARIABLES.has(name.toUpperCase());
}

/**
 * Build the child environment: optionally drop the Git namespace wholesale, then layer the values
 * a lane explicitly needs. `null` removes a variable outright.
 *
 * Proxy routing is deliberately kept so managed networks remain reachable. Caller-selected CA
 * bundles, TLS backends and secret-log targets are not: they either replace the trust root that
 * authenticates the canonical host or grant the child a write outside its scratch directory.
 */
function environmentFor(
  limits: PluginDeliveryQueryLimits,
): { env?: Record<string, string | undefined> } {
  if (limits.hermeticGit !== true && limits.env === undefined) return {};
  const environment: Record<string, string | undefined> = { ...process.env };
  if (limits.hermeticGit === true) {
    for (const name of Object.keys(environment)) {
      if (isGitSteeringVariable(name) || isNetworkTrustSteeringVariable(name)) delete environment[name];
    }
  }
  for (const [name, value] of Object.entries(limits.env ?? {})) {
    if (value === null) delete environment[name];
    else environment[name] = value;
  }
  return { env: environment };
}

/** Both hosts keep their own root; nothing outside it is ever read. */
function defaultResolveHostHome(host: PluginDeliveryHost): string | null {
  let home: string;
  try {
    home = homedir();
  } catch {
    return null;
  }
  if (host === "codex") {
    const configured = process.env["CODEX_HOME"];
    if (typeof configured === "string" && configured.trim().length > 0) {
      const candidate = configured.trim();
      return isLocalFilesystemPath(candidate) ? resolve(candidate) : null;
    }
  }
  return isLocalFilesystemPath(home) ? resolve(join(home, host === "codex" ? ".codex" : ".claude")) : null;
}

type PathKind = "any" | "directory" | "file";

/** A path proven to be link-free and confined, together with the size of its final component. */
interface ConfinedPath {
  path: string;
  size: number;
}

/**
 * Walk from a trusted root one path component at a time. `lstat` never follows the component it
 * inspects, so a symlink/junction is rejected before its target — including a UNC target — can be
 * resolved or touched. The final component's size is returned with the path so a caller can refuse
 * an oversized artifact before reading it, using the metadata of the very entry it walked to.
 */
function walkExistingPathWithoutLinks(candidate: string, root: string, kind: PathKind): ConfinedPath | null {
  try {
    const resolvedRoot = resolve(root);
    const resolvedCandidate = resolve(candidate);
    const canonicalRoot = realpathSync.native(resolvedRoot);
    // Windows runners can expose the same local tree through two absolute aliases (for example a
    // workspace drive and its canonical runner path). Keep the independent root authoritative, but
    // accept the candidate when it is confined under either spelling of that exact root.
    const suffix = isWithin(resolvedCandidate, resolvedRoot)
      ? relative(resolvedRoot, resolvedCandidate)
      : isWithin(resolvedCandidate, canonicalRoot)
        ? relative(canonicalRoot, resolvedCandidate)
        : null;
    if (suffix === null) return null;
    const segments = suffix === "" ? [] : suffix.split(/[\\/]/).filter(Boolean);
    let current = canonicalRoot;
    let stats = lstatSync(current);
    if (stats.isSymbolicLink() || !stats.isDirectory()) return null;

    for (let index = 0; index < segments.length; index += 1) {
      current = join(current, segments[index] ?? "");
      stats = lstatSync(current);
      if (stats.isSymbolicLink()) return null;
      if (index < segments.length - 1 && !stats.isDirectory()) return null;
    }

    if (kind === "directory" && !stats.isDirectory()) return null;
    if (kind === "file" && !stats.isFile()) return null;
    return { path: current, size: stats.size };
  } catch {
    return null;
  }
}

function canonicalDirectoryWithin(candidate: string, root: string): string | null {
  return walkExistingPathWithoutLinks(candidate, root, "directory")?.path ?? null;
}

function canonicalRegularFileWithin(file: string, root: string): ConfinedPath | null {
  return walkExistingPathWithoutLinks(file, root, "file");
}

/**
 * Read a confined file through a single descriptor, bounded.
 *
 * The confinement walk proves the *path* holds no link and stays inside the root, but its `stat`
 * describes an object that a second `open` is not guaranteed to reach: between the two, the entry
 * can be replaced and the size can change. So the file is opened once, and every decision after
 * that — regular file, size, how much is read — is taken from `fstat` on that descriptor and from
 * the bytes it yields. The ceiling is enforced on what is actually read, with one extra byte
 * requested so a file that grew past it is refused rather than silently truncated.
 *
 * Residual limit, stated rather than promised away: on Windows this does not open with
 * `FILE_FLAG_OPEN_REPARSE_POINT`, so a reparse point swapped in between the walk and the open is
 * not portably detectable here. The walk's link refusals and canonical confinement remain the
 * defence against that; this closes the size and identity window, not the reparse race.
 */
export function readConfinedFile(
  file: string,
  root: string,
  maxBytes: number,
  afterMetadata?: () => void,
): Buffer | null {
  const canonicalFile = canonicalRegularFileWithin(file, root);
  if (canonicalFile === null) return null;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(canonicalFile.path, "r");
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.size === 0 || stats.size > maxBytes) return null;
    // Internal deterministic test seam for the post-fstat race. It is not exported from the
    // package entrypoint and production callers never provide it.
    afterMetadata?.();
    const buffer = Buffer.alloc(maxBytes + 1);
    let filled = 0;
    for (;;) {
      const read = readSync(descriptor, buffer, filled, buffer.length - filled, null);
      if (read === 0) break;
      filled += read;
      // The descriptor delivered more than the ceiling allows: refuse rather than hash a prefix.
      if (filled > maxBytes) return null;
    }
    return filled === 0 ? null : buffer.subarray(0, filled);
  } catch {
    return null;
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // Nothing observable depends on the close succeeding.
      }
    }
  }
}

/** Digest a confined file. A host cache is untrusted input, so the read is bounded throughout. */
function digestFile(file: string, root: string, maxBytes: number): string | null {
  const bytes = readConfinedFile(file, root, maxBytes);
  return bytes === null ? null : createHash("sha256").update(bytes).digest("hex");
}

function bundleDigests(distRoot: string, root: string): Record<string, string | null> {
  const bundles: Record<string, string | null> = {};
  for (const name of PLUGIN_RUNTIME_BUNDLES) {
    bundles[name] = digestFile(join(distRoot, name), root, PLUGIN_DELIVERY_MAX_BUNDLE_BYTES);
  }
  return bundles;
}

/**
 * Codex records the resolved source, ref and revision in the marketplace root; both hosts also
 * leave a Git checkout there. The declarative file is preferred because it needs no subprocess.
 */
function defaultReadMarketplaceSnapshot(
  host: PluginDeliveryHost,
  root: string,
  runQuery: QueryRunner,
): MarketplaceSnapshotProbe | null {
  if (!isLocalFilesystemPath(root) || !existsSync(root)) return null;
  const canonicalRoot = canonicalDirectoryWithin(root, root);
  if (canonicalRoot === null) return null;

  let commit: string | null = null;
  let ref: string | null = null;
  let source: string | null = null;
  try {
    const metadata = readConfinedFile(
      join(canonicalRoot, ".codex-marketplace-install.json"),
      canonicalRoot,
      PLUGIN_DELIVERY_MAX_MANIFEST_BYTES,
    );
    const raw = metadata === null ? undefined : parseJsonValue(metadata.toString("utf8"));
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      const record = raw as Record<string, unknown>;
      commit = safeText(record["revision"]);
      ref = safeText(record["ref_name"]);
      source = safeText(record["source"]);
    }
  } catch {
    // No declarative metadata; fall back to the checkout below.
  }
  if (commit === null) {
    const head = runQuery(["git", "--no-replace-objects", "rev-parse", "HEAD"], canonicalRoot, LOCAL_READ_LIMITS);
    if (head.code === 0) commit = safeText(head.out.trim());
  }
  if (ref === null) {
    const branch = runQuery(
      ["git", "--no-replace-objects", "rev-parse", "--abbrev-ref", "HEAD"],
      canonicalRoot,
      LOCAL_READ_LIMITS,
    );
    if (branch.code === 0) {
      const name = safeText(branch.out.trim());
      ref = name === "HEAD" ? null : name;
    }
  }

  // Each host's snapshot is a full checkout, so both manifests exist in it; read the one that
  // actually governs this host rather than whichever happens to be found first.
  const layout = RELEASE_PLUGIN[host];
  const pluginRoot = canonicalDirectoryWithin(join(canonicalRoot, "plugins", layout.directory), canonicalRoot);
  if (pluginRoot === null) return null;
  const version = readJsonField(join(pluginRoot, layout.manifest, "plugin.json"), "version", canonicalRoot);

  return { commit, ref, source, version, bundles: bundleDigests(join(pluginRoot, "dist"), canonicalRoot) };
}

function readJsonField(file: string, field: string, root: string): string | null {
  // A manifest is a small JSON document. A file claiming to be one while being far larger is
  // refused by the bounded read rather than parsed.
  const bytes = readConfinedFile(file, root, PLUGIN_DELIVERY_MAX_MANIFEST_BYTES);
  if (bytes === null) return null;
  const raw = parseJsonValue(bytes.toString("utf8"));
  return raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? safeText((raw as Record<string, unknown>)[field])
    : null;
}

function defaultReadInstalledPayload(
  host: PluginDeliveryHost,
  path: string,
): InstalledPayloadProbe | null {
  if (!isLocalFilesystemPath(path) || !existsSync(path)) return null;
  const canonicalRoot = canonicalDirectoryWithin(path, path);
  if (canonicalRoot === null) return null;
  const version = readJsonField(
    join(canonicalRoot, RELEASE_PLUGIN[host].manifest, "plugin.json"),
    "version",
    canonicalRoot,
  );
  if (version === null) return null;
  return { version, bundles: bundleDigests(join(canonicalRoot, "dist"), canonicalRoot) };
}

function defaultReadRepositoryChannel(
  repositoryRoot: string,
  runQuery: QueryRunner,
): RepositoryChannelProbe {
  const head = runQuery(["git", "--no-replace-objects", "rev-parse", "HEAD"], repositoryRoot, LOCAL_READ_LIMITS);
  const origin = runQuery(["git", "config", "--get", "remote.origin.url"], repositoryRoot, LOCAL_READ_LIMITS);
  return {
    commit: head.code === 0 ? safeText(head.out.trim()) : null,
    originIsSemctx: origin.code === 0 && isSemctxSource(origin.out.trim()),
  };
}

const COMMIT_ID = /^[0-9a-f]{40}$/;

const ARTIFACT_LIMITS: PluginDeliveryQueryLimits = {
  timeoutMs: PLUGIN_DELIVERY_QUERY_TIMEOUT_MS,
  maxBytes: PLUGIN_DELIVERY_MAX_ARTIFACT_BYTES,
  hermeticGit: true,
};

function unresolvedRelease(
  authority: PublicReleaseAuthority,
  ...reasons: string[]
): PublicReleaseProbe {
  return { authority, status: "unknown", version: null, commit: null, source: null, reasons, bundles: null };
}

/**
 * Read one blob out of a Git object store, at a fixed commit.
 *
 * `cat-file blob` streams the stored bytes: no clean/smudge filter, no end-of-line translation, no
 * replacement objects. That matters twice over — a digest must compare directly with a file read
 * from a host cache, and on a checkout configured with `core.autocrlf` a filtered read would
 * silently produce a different hash for identical content.
 */
function releaseBlobReader(
  gitDir: string | null,
  cwd: string,
  commit: string,
  runQuery: QueryRunner,
  env: Readonly<Record<string, string | null>> | undefined,
): (path: string) => PluginDeliveryQueryOutcome {
  const limits: PluginDeliveryQueryLimits = {
    ...ARTIFACT_LIMITS,
    ...(env === undefined ? {} : { env }),
  };
  return (path) => runQuery(
    [
      "git",
      ...(gitDir === null ? [] : [`--git-dir=${gitDir}`]),
      "--no-replace-objects",
      "cat-file",
      "blob",
      `${commit}:${path}`,
    ],
    cwd,
    limits,
  );
}

function jsonField(out: string, field: string): string | null {
  const parsed = parseJsonValue(out);
  return parsed !== undefined && parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? safeText((parsed as Record<string, unknown>)[field])
    : null;
}

/** Why a release could not be read as one coherent artifact. */
type ReleaseArtifactFailure = "unreadable" | "diverged";

interface ReleaseArtifacts {
  version: string;
  bundles: PublicReleaseBundleWitnesses;
}

/**
 * Read the facts bound to one release commit: the released version, and — per host plugin — that
 * plugin's own declared version and the SHA-256 of each of its runtime bundles.
 *
 * Both host plugins are read separately and each must declare the released version. A release
 * whose two host payloads disagree is not one artifact, and saying so is the only honest answer:
 * silently reusing one host's bundles for the other would manufacture the very cross-host equality
 * this proof exists to establish.
 */
function readReleaseArtifacts(
  gitDir: string | null,
  cwd: string,
  commit: string,
  runQuery: QueryRunner,
  env: Readonly<Record<string, string | null>> | undefined,
): ReleaseArtifacts | ReleaseArtifactFailure {
  const read = releaseBlobReader(gitDir, cwd, commit, runQuery, env);
  const payloadOf = (outcome: PluginDeliveryQueryOutcome, maxBytes: number): Uint8Array | null => {
    if (outcome.code !== 0 || boundedFailure(outcome) !== null) return null;
    const payload = outcome.bytes ?? new TextEncoder().encode(outcome.out);
    return payload.byteLength <= maxBytes ? payload : null;
  };

  const manifest = read("apps/cli/package.json");
  if (payloadOf(manifest, PLUGIN_DELIVERY_MAX_MANIFEST_BYTES) === null) return "unreadable";
  const version = jsonField(manifest.out, "version");
  if (version === null) return "unreadable";

  const bundles = { codex: {}, claude: {} } as PublicReleaseBundleWitnesses;
  for (const host of PLUGIN_DELIVERY_HOSTS) {
    const layout = RELEASE_PLUGIN[host];
    const pluginManifest = read(`plugins/${layout.directory}/${layout.manifest}/plugin.json`);
    if (payloadOf(pluginManifest, PLUGIN_DELIVERY_MAX_MANIFEST_BYTES) === null) return "unreadable";
    if (jsonField(pluginManifest.out, "version") !== version) return "diverged";

    const record: Record<string, string | null> = {};
    for (const name of PLUGIN_RUNTIME_BUNDLES) {
      const artifact = read(`plugins/${layout.directory}/dist/${name}`);
      // Raw bytes only. A decoded string would not round-trip to the stored bytes, so a digest
      // taken from it would be a digest of something the release does not contain.
      const payload = payloadOf(artifact, PLUGIN_DELIVERY_MAX_BUNDLE_BYTES);
      record[name] = payload !== null && payload.length > 0
        ? createHash("sha256").update(payload).digest("hex")
        : null;
    }
    bundles[host] = record;
  }
  return { version, bundles };
}

/**
 * What the attested lane reintroduces after the Git namespace has been dropped.
 *
 * Everything inherited is already gone by the time these apply, so this list is an allowlist rather
 * than a set of patches: configuration is pinned at two paths that do not exist, transport is
 * pinned to verified `https`, no prompt or credential helper can block or answer, and no
 * replacement, alternate, template, namespace or lazy-fetch mechanism is reachable. Nothing here
 * re-enables tracing, so `GIT_TRACE*` cannot write a file anywhere.
 *
 * What remains outside this boundary, and is stated rather than claimed away: which `git` binary
 * `PATH` resolves, the operating system, and the system certificate store that decides whether the
 * canonical host's certificate is trusted.
 */
function isolatedGitEnvironment(scratch: string): Readonly<Record<string, string | null>> {
  return {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: join(scratch, "absent-system-config"),
    GIT_CONFIG_GLOBAL: join(scratch, "absent-global-config"),
    GIT_ATTR_NOSYSTEM: "1",
    GIT_ALLOW_PROTOCOL: "https",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_LAZY_FETCH: "1",
    GCM_INTERACTIVE: "never",
  };
}

/**
 * What the local lane reintroduces after the Git namespace has been dropped.
 *
 * Configuration files are deliberately *not* neutralised here, unlike the attested lane: this lane
 * must read the repository it was pointed at, and `safe.directory` — the setting that decides
 * whether Git will touch a checkout at all — lives in the user's global configuration. Dropping it
 * would turn ordinary repositories into unreadable ones. The lane makes no network call, so the
 * rewrite and credential settings that matter for attestation are inert here; what does matter is
 * that no inherited variable can point the read at another repository, write a trace, or turn a
 * local lookup into a promisor fetch.
 */
const LOCAL_READ_ENVIRONMENT: Readonly<Record<string, string | null>> = {
  GIT_NO_LAZY_FETCH: "1",
  GIT_TERMINAL_PROMPT: "0",
  // No optional lock, so reading never refreshes an index inside the inspected repository.
  GIT_OPTIONAL_LOCKS: "0",
};

const LOCAL_READ_LIMITS: PluginDeliveryQueryLimits = {
  timeoutMs: PLUGIN_DELIVERY_QUERY_TIMEOUT_MS,
  maxBytes: PLUGIN_DELIVERY_MAX_HOST_OUTPUT_BYTES,
  hermeticGit: true,
  env: LOCAL_READ_ENVIRONMENT,
};

/**
 * Resolve the public `stable` release.
 *
 * Two provenances, and the caller decides which is available:
 *
 * - **attested** (`attest`): the canonical public repository is asked directly, in an isolated
 *   throwaway object store, with the ambient Git configuration removed. This is the one step that
 *   leaves the machine; it is opt-in, time-bounded and acceptance-capped, and it neither reads nor
 *   writes the inspected project. It deliberately takes no `repositoryRoot`.
 * - **local mirror** (default): the already-fetched `origin/stable` of an inspected project that
 *   provably *is* a semctx clone. It identifies what was fetched, but cannot prove no newer public
 *   release exists, so it never licenses `UP_TO_DATE` — and therefore never needs bundle digests.
 *
 * Offline, timed out, or otherwise unproven attestation degrades to `absent` — never to the mirror
 * silently wearing an attested label.
 */
function defaultResolvePublicRelease(
  repositoryRoot: string,
  runQuery: QueryRunner,
  attest: boolean,
  resolveHostHome: PluginDeliveryDependencies["resolveHostHome"],
): PublicReleaseProbe {
  return attest
    ? attestPublicRelease(runQuery, repositoryRoot, resolveHostHome)
    : mirrorPublicRelease(repositoryRoot, runQuery);
}

/**
 * Attest the public `stable` release against the canonical authority.
 *
 * The inspected project contributes nothing — not its `origin`, not its configuration, not its
 * object store, not its refs. A throwaway bare repository is created outside it, one shallow fetch
 * brings exactly one commit of the canonical repository into that store, and the release facts are
 * read from those immutable objects. The fetch has a time ceiling but no transport-byte ceiling;
 * the completed store is acceptance-capped before any witness is read. The store is removed
 * whatever the outcome.
 *
 * The fetch is what makes the proof self-contained: it is the only way the version and the
 * host-specific bundle witnesses can come from the public release itself rather than from whatever
 * a consumer happens to have on disk. Nothing is written outside the scratch directory, and no
 * user-visible Git state is touched.
 */
function attestPublicRelease(
  runQuery: QueryRunner,
  inspectedRoot: string,
  resolveHostHome: PluginDeliveryDependencies["resolveHostHome"],
): PublicReleaseProbe {
  // `inspectedRoot` reaches this function for exactly one purpose — proving the scratch store does
  // not land inside it — and for no other. It never contributes to what the public release is.
  const base = attestationScratchBase(inspectedRoot, resolveHostHome);
  if (base === null) {
    return unresolvedRelease("absent", "PUBLIC_RELEASE_SCRATCH_LOCATION_REJECTED");
  }
  let scratch: string;
  try {
    scratch = mkdtempSync(join(base, "semctx-attestation-"));
  } catch {
    return unresolvedRelease("absent", "PUBLIC_RELEASE_ATTESTATION_STORE_UNAVAILABLE");
  }
  let outcome: PublicReleaseProbe;
  try {
    outcome = attestInScratch(scratch, runQuery);
  } catch {
    // Filesystem and injected process seams are not allowed to skip structured failure or cleanup.
    outcome = unresolvedRelease("absent", "PUBLIC_RELEASE_ATTESTATION_UNAVAILABLE");
  }
  // A store that could not be removed is a leaked copy of the release on disk. Reporting the
  // attestation as healthy anyway would be exactly the silent success this must not produce.
  if (!removeScratch(scratch)) {
    return unresolvedRelease("absent", "PUBLIC_RELEASE_SCRATCH_NOT_REMOVED");
  }
  return outcome;
}

/**
 * Choose where the throwaway store may live, before anything is created.
 *
 * `os.tmpdir()` is whatever `TEMP`/`TMP` say, which means the caller's environment picks the
 * directory this command writes to. A relative base, a UNC or device path, or a base inside the
 * inspected project or a host's own tree would each turn a read-only diagnostic into a writer in
 * somewhere it has no business writing — so the location is refused before the first `mkdtemp`,
 * not cleaned up afterwards.
 */
function attestationScratchBase(
  inspectedRoot: string,
  resolveHostHome: PluginDeliveryDependencies["resolveHostHome"],
): string | null {
  let base: string;
  try {
    base = tmpdir();
  } catch {
    return null;
  }
  // Relative, UNC and device paths are rejected on their shape; a UNC base would additionally make
  // every write an SMB round trip, which is network egress from a path that claims to be local.
  if (!isLocalFilesystemPath(base)) return null;
  const resolved = resolve(base);
  let canonical: string;
  try {
    canonical = realpathSync.native(resolved);
    if (!isLocalFilesystemPath(canonical) || !lstatSync(canonical).isDirectory()) return null;
  } catch {
    return null;
  }

  const excluded: string[] = [];
  const exclude = (candidate: string): void => {
    if (!isLocalFilesystemPath(candidate)) return;
    const lexical = resolve(candidate);
    excluded.push(lexical);
    try {
      const actual = realpathSync.native(lexical);
      if (isLocalFilesystemPath(actual)) excluded.push(actual);
    } catch {
      // A missing exclusion still participates lexically; existing roots also contribute real paths.
    }
  };
  exclude(inspectedRoot);
  for (const host of PLUGIN_DELIVERY_HOSTS) {
    const home = resolveHostHome(host);
    // Host homes are resolved read-only; a host that cannot be located simply contributes no
    // exclusion rather than blocking the attestation.
    if (home !== null) exclude(home);
  }
  for (const forbidden of excluded) {
    if (isWithin(resolved, forbidden) || isWithin(canonical, forbidden)) return null;
  }
  // Use the canonical target itself for `mkdtemp`, so swapping an alias after this check cannot
  // redirect the write back into a forbidden tree.
  return canonical;
}

/**
 * Remove the scratch store and prove it is gone.
 *
 * On Windows a just-exited Git process can still hold a handle for a moment, so removal is retried
 * within a bounded window instead of being attempted once and assumed. The final answer comes from
 * looking, not from the absence of an exception: `rmSync` with `force` succeeds on paths it did not
 * actually clear.
 */
function removeScratch(scratch: string): boolean {
  for (let attempt = 0; attempt < SCRATCH_REMOVAL_ATTEMPTS; attempt += 1) {
    try {
      rmSync(scratch, { recursive: true, force: true });
    } catch {
      // Retried below; a transient lock is not yet a failure.
    }
    if (!existsSync(scratch)) return true;
    Bun.sleepSync(SCRATCH_REMOVAL_RETRY_MS);
  }
  return !existsSync(scratch);
}

/** Everything the attestation does inside its store; the caller owns creating and removing it. */
function attestInScratch(scratch: string, runQuery: QueryRunner): PublicReleaseProbe {
  const store = join(scratch, "store");
  const template = join(scratch, "template");
  const environment = isolatedGitEnvironment(scratch);
  const limits: PluginDeliveryQueryLimits = { ...ARTIFACT_LIMITS, env: environment };
  {
    // An empty template keeps the store free of inherited hooks and seeded configuration.
    mkdirSync(template, { recursive: true });

    const created = runQuery(
      ["git", "init", "--bare", "--quiet", `--template=${template}`, store],
      scratch,
      limits,
    );
    if (created.code !== 0) {
      return unresolvedRelease("absent", "PUBLIC_RELEASE_ATTESTATION_STORE_UNAVAILABLE");
    }

    const fetched = runQuery(
      [
        "git",
        `--git-dir=${store}`,
        "-c", "credential.helper=",
        "-c", "credential.interactive=false",
        "-c", "protocol.version=2",
        "fetch",
        "--quiet",
        "--depth=1",
        "--no-tags",
        PLUGIN_DELIVERY_RELEASE_URL,
        `+refs/heads/${PLUGIN_DELIVERY_RELEASE_REF}:${ATTESTED_RELEASE_REF}`,
      ],
      scratch,
      { ...limits, timeoutMs: PLUGIN_DELIVERY_ATTESTATION_TIMEOUT_MS },
    );
    if (fetched.timedOut === true) {
      return unresolvedRelease("absent", "PUBLIC_RELEASE_ATTESTATION_TIMEOUT");
    }
    if (fetched.code !== 0 || fetched.truncated === true) {
      return unresolvedRelease("absent", "PUBLIC_RELEASE_ATTESTATION_UNAVAILABLE");
    }

    // `--depth=1` bounds ancestry, not the pack: one commit of a repository with enormous blobs is
    // still an unbounded download. The transfer itself has no byte ceiling, so what is bounded is
    // *acceptance* — a store past this size is refused before a single witness is read from it.
    if (storeExceeds(store, PLUGIN_DELIVERY_MAX_STORE_BYTES)) {
      return unresolvedRelease("absent", "PUBLIC_RELEASE_STORE_TOO_LARGE");
    }

    const head = runQuery(
      ["git", `--git-dir=${store}`, "--no-replace-objects", "rev-parse", ATTESTED_RELEASE_REF],
      scratch,
      limits,
    );
    const commit = head.code === 0 ? safeText(head.out.trim()) : null;
    if (commit === null || !COMMIT_ID.test(commit)) {
      return unresolvedRelease("absent", "PUBLIC_RELEASE_ATTESTATION_MALFORMED");
    }

    const artifacts = readReleaseArtifacts(store, scratch, commit, runQuery, environment);
    if (artifacts === "unreadable") {
      return unresolvedRelease("absent", "PUBLIC_RELEASE_MANIFEST_UNREADABLE");
    }
    if (artifacts === "diverged") {
      return unresolvedRelease("absent", "PUBLIC_RELEASE_VERSION_DIVERGED");
    }
    return {
      authority: "attested-release",
      status: "resolved",
      version: artifacts.version,
      commit,
      source: "canonical-public-release",
      reasons: [],
      bundles: artifacts.bundles,
    };
  }
}

/**
 * Whether the store has grown past what this diagnostic is willing to have on disk.
 *
 * The walk stops at the first byte over the ceiling instead of totalling everything, so an
 * oversized store costs a partial traversal rather than a full one. A directory that cannot be
 * walked is treated as over the ceiling: an unmeasurable store is not a small one.
 */
function storeExceeds(root: string, maxBytes: number): boolean {
  let total = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop() ?? "";
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        total += lstatSync(full).size;
      } catch {
        return true;
      }
      if (total > maxBytes) return true;
    }
  }
  return false;
}

/**
 * Report the already-fetched `origin/stable` of the inspected project.
 *
 * This path is informational by construction, so it stops at commit and version: bundle digests
 * could never license anything here, and reading several megabytes of Git objects to compute
 * witnesses that are then discarded would be cost without evidence.
 */
function mirrorPublicRelease(repositoryRoot: string, runQuery: QueryRunner): PublicReleaseProbe {
  const origin = runQuery(["git", "config", "--get", "remote.origin.url"], repositoryRoot, LOCAL_READ_LIMITS);
  if (origin.code !== 0 || !isSemctxSource(origin.out.trim())) {
    return unresolvedRelease("absent", "PUBLIC_RELEASE_ORIGIN_NOT_SEMCTX");
  }
  // A partial clone answers a local read by fetching from its promisor. That is a network call
  // from the default, no-network path, and it would make a "local" mirror silently remote.
  const partial = runQuery(
    ["git", "config", "--get", "extensions.partialclone"],
    repositoryRoot,
    LOCAL_READ_LIMITS,
  );
  if (partial.code === 0 && partial.out.trim().length > 0) {
    return unresolvedRelease("absent", "PUBLIC_RELEASE_LOCAL_STORE_PARTIAL");
  }

  const ref = runQuery(
    [
      "git",
      "--no-replace-objects",
      "rev-parse",
      "--verify",
      `refs/remotes/origin/${PLUGIN_DELIVERY_RELEASE_REF}`,
    ],
    repositoryRoot,
    LOCAL_READ_LIMITS,
  );
  if (ref.code !== 0) return unresolvedRelease("absent", "PUBLIC_RELEASE_REF_ABSENT");
  const commit = safeText(ref.out.trim());
  if (commit === null || !COMMIT_ID.test(commit)) {
    return unresolvedRelease("absent", "PUBLIC_RELEASE_REF_ABSENT");
  }
  const manifest = releaseBlobReader(null, repositoryRoot, commit, runQuery, LOCAL_READ_ENVIRONMENT)(
    "apps/cli/package.json",
  );
  if (manifest.code !== 0 || boundedFailure(manifest) !== null) {
    return unresolvedRelease("absent", "PUBLIC_RELEASE_MANIFEST_UNREADABLE");
  }
  const version = jsonField(manifest.out, "version");
  if (version === null) return unresolvedRelease("absent", "PUBLIC_RELEASE_MANIFEST_UNREADABLE");

  return {
    // The mirror proves what was fetched, not that no newer public stable commit exists.
    authority: "local-mirror",
    status: "unknown",
    version,
    commit,
    // A remote-tracking ref is a local mirror: it is only as current as the last fetch.
    source: "git-remote-tracking-ref",
    reasons: ["PUBLIC_RELEASE_FROM_LOCAL_MIRROR", "PUBLIC_RELEASE_FRESHNESS_UNATTESTED"],
    bundles: null,
  };
}

/**
 * No supported host exposes the plugin version a running session loaded. Reporting it as unknown
 * is the honest answer; inferring it from the installed cache is exactly the confusion this whole
 * report exists to prevent.
 */
function defaultObserveSessionVersion(_host: PluginDeliveryHost): SessionVersionProbe {
  return {
    status: "unknown",
    version: null,
    reason: "no host metadata exposes the plugin version a running session loaded",
  };
}
