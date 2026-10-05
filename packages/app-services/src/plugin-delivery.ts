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
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  type Dirent,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

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
 * inspected project or a host's tree. Claude inventory is read from its declarative metadata,
 * because starting its CLI for a nominal list query writes profile bookkeeping. Any unavailable,
 * malformed, or partial evidence produces an explicit `UNKNOWN`, never an optimistic
 * `UP_TO_DATE`.
 *
 * Two modes, and they differ in exactly one respect:
 *
 * - **default** — local declarative Codex and Claude reads. No network operation.
 * - **`--attest`** — additionally resolves and *fetches* the canonical public release into a
 *   throwaway store outside the project, then deletes it. This is a real network transfer, opt-in
 *   by name, and it is the only one. Saying "never fetches" of the whole command would be false;
 *   what holds is that nothing is fetched implicitly and Semctx's only write is the disposable
 *   attestation store.
 */

/**
 * `2` since the HOK-585 amendment to ADR 0014: `marketplace.configured` is `boolean | null`, because
 * a host whose plugin inventory interface is unavailable must report unknown rather than an
 * optimistic `false`. Within a major version, changes stay additive per ADR 0008.
 */
export const PLUGIN_DELIVERY_SCHEMA_VERSION = 2;

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
const NATIVE_SEMVER_MAX_COMPONENT = 18_446_744_073_709_551_615n;

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
  | "HOST_INTERFACE_UNSUPPORTED"
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
  | "PLUGIN_ENABLEMENT_UNKNOWN"
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
  "HOST_INTERFACE_UNSUPPORTED",
  "HOST_PATH_REJECTED",
  "MARKETPLACE_NOT_CONFIGURED",
  "MARKETPLACE_SOURCE_MISMATCH",
  "MARKETPLACE_REF_UNKNOWN",
  "SNAPSHOT_UNREADABLE",
  "SNAPSHOT_COMMIT_UNKNOWN",
  "SNAPSHOT_VERSION_UNKNOWN",
  "SNAPSHOT_CONTENT_UNPROVEN",
  "PLUGIN_NOT_INSTALLED",
  "PLUGIN_ENABLEMENT_UNKNOWN",
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

/** Claude's declarative plugin metadata, projected to the stable CLI inventory shape. */
export interface ClaudePluginMetadataInventory {
  marketplaces: Record<string, unknown>[];
  plugins: Record<string, unknown>[];
  /** False when any applicable settings layer is linked, unreadable or malformed. */
  settingsValid: boolean;
  /** Effective explicit setting after user -> project -> local precedence, including uninstalled ids. */
  effectiveEnablement: Record<
    string,
    { enabled: boolean; scope: "user" | "project" | "local" }
  >;
}

/** What a marketplace snapshot directory declares about the source it was resolved from. */
export interface MarketplaceSnapshotProbe {
  /** Exact Codex plugin manifest identity; Claude has no corresponding requirement. */
  pluginIdentity: CodexPluginManifestIdentity | null;
  /** Present only for a validated native Codex sidecar; its identity must match the configuration. */
  sourceType?: "git" | "local";
  /** Native sparse checkout identity, preserving order, duplicates and raw strings. */
  sparsePaths?: readonly string[];
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
  /** Exact Codex plugin manifest identity; Claude has no corresponding requirement. */
  pluginIdentity: CodexPluginManifestIdentity | null;
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
  /** Read-only PATH lookup; native host version commands may write profile bookkeeping. */
  findHostExecutable?(host: PluginDeliveryHost): string | null;
  /** Declarative Codex inventory; production does not launch Codex for a status query. */
  readCodexPluginMetadata?(repositoryRoot: string): CodexPluginMetadataInventory | null;
  /**
   * Read Claude's declarative metadata without launching Claude Code. The native `plugin list`
   * commands maintain profile bookkeeping even when used only for diagnosis, so the production
   * default uses this seam and treats unavailable metadata as unknown.
   */
  readClaudePluginMetadata?(repositoryRoot: string): ClaudePluginMetadataInventory | null;
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

export interface HostMarketplaceStateV2 {
  name: string;
  /**
   * `boolean | null` since schema `2` (HOK-585): a successfully read, empty inventory proves
   * `false`; an unavailable inventory — the host interface is unsupported, the query failed, timed
   * out, or the host was never detected — must report `null` instead of an optimistic `false`.
   */
  configured: boolean | null;
  source: string | null;
  ref: string | null;
  matchesSemctx: boolean | null;
}

export interface HostSnapshotStateV2 {
  commit: string | null;
  version: string | null;
  path: string | null;
}

export interface HostInstalledStateV2 {
  version: string | null;
  path: string | null;
  installed: boolean | null;
  /** `null` when the host did not report a boolean at all — never an optimistic `false`. */
  enabled: boolean | null;
  /** Whether every runtime bundle in the cache digests equal to the snapshot. `null` if unproven. */
  contentMatchesSnapshot: boolean | null;
  /** Whether every cache bundle digest equals the immutable public-release witness. */
  contentMatchesPublicRelease: boolean | null;
}

export interface HostSessionStateV2 {
  status: "observed" | "unknown";
  version: string | null;
  reason: string | null;
}

export interface HostPluginDeliveryV2 {
  requested: boolean;
  detected: boolean;
  marketplace: HostMarketplaceStateV2;
  snapshot: HostSnapshotStateV2;
  installed: HostInstalledStateV2;
  session: HostSessionStateV2;
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

export interface RepositoryChannelV2 {
  version: string;
  commit: string | null;
  originIsSemctx: boolean;
  /** `false` when the checkout is not at the released commit; `null` when unresolvable. */
  matchesPublicRelease: boolean | null;
  /** Structural statement of the invariant: repository state is never delivery evidence. */
  conveysDelivery: false;
}

export interface PublicReleaseV2 {
  /** Typed provenance; only `attested-release` can license a converged delivery verdict. */
  authority: PublicReleaseAuthority | "unrecognised";
  status: "resolved" | "unknown";
  version: string | null;
  commit: string | null;
  source: string | null;
  reasons: string[];
}

export interface PluginDeliveryReportV2 {
  schemaVersion: typeof PLUGIN_DELIVERY_SCHEMA_VERSION;
  kind: "plugin_delivery_status";
  /** Delivery and activation together; `UP_TO_DATE` only when nothing is left to do. */
  verdict: PluginDeliveryVerdict;
  /** Delivery alone: whether every observed host executes the public `stable` release. */
  delivery: PluginDeliveryVerdict;
  repository: RepositoryChannelV2;
  publicRelease: PublicReleaseV2;
  hosts: Record<PluginDeliveryHost, HostPluginDeliveryV2>;
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

function rawText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** A Semctx version is an identity: no trimming, control removal or display redaction. */
function codexVersionIdentity(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() !== value) return null;
  const match = VERSION_SEGMENT.exec(value);
  if (match === null) return null;
  return match.slice(1, 4).every((component) => component !== undefined
    && BigInt(component) <= NATIVE_SEMVER_MAX_COMPONENT) ? value : null;
}

interface NativeCodexVersion {
  core: readonly [bigint, bigint, bigint];
  prerelease: string;
  build: string;
}

function parseNativeCodexVersion(value: string): NativeCodexVersion | null {
  if (codexVersionIdentity(value) === null) return null;
  const buildSeparator = value.indexOf("+");
  const withoutBuild = buildSeparator === -1 ? value : value.slice(0, buildSeparator);
  const prereleaseSeparator = withoutBuild.indexOf("-");
  const core = (prereleaseSeparator === -1 ? withoutBuild : withoutBuild.slice(0, prereleaseSeparator))
    .split(".");
  if (core.length !== 3) return null;
  return {
    core: [BigInt(core[0] ?? ""), BigInt(core[1] ?? ""), BigInt(core[2] ?? "")],
    prerelease: prereleaseSeparator === -1 ? "" : withoutBuild.slice(prereleaseSeparator + 1),
    build: buildSeparator === -1 ? "" : value.slice(buildSeparator + 1),
  };
}

function compareScalar(left: bigint | number | string, right: bigint | number | string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNativePrerelease(left: string, right: string): number {
  if (left === right) return 0;
  if (left === "") return 1;
  if (right === "") return -1;
  const leftParts = left.split(".");
  const rightParts = right.split(".");
  for (let index = 0; index < Math.min(leftParts.length, rightParts.length); index += 1) {
    const leftPart = leftParts[index] ?? "";
    const rightPart = rightParts[index] ?? "";
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    const comparison = leftNumeric && rightNumeric
      ? compareScalar(leftPart.length, rightPart.length) || compareScalar(leftPart, rightPart)
      : leftNumeric ? -1 : rightNumeric ? 1 : compareScalar(leftPart, rightPart);
    if (comparison !== 0) return comparison;
  }
  return compareScalar(leftParts.length, rightParts.length);
}

function compareNativeBuild(left: string, right: string): number {
  if (left === right) return 0;
  if (left === "") return -1;
  if (right === "") return 1;
  const leftParts = left.split(".");
  const rightParts = right.split(".");
  for (let index = 0; index < Math.min(leftParts.length, rightParts.length); index += 1) {
    const leftPart = leftParts[index] ?? "";
    const rightPart = rightParts[index] ?? "";
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    let comparison: number;
    if (leftNumeric && rightNumeric) {
      const leftValue = leftPart.replace(/^0+/, "");
      const rightValue = rightPart.replace(/^0+/, "");
      comparison = compareScalar(leftValue.length, rightValue.length)
        || compareScalar(leftValue, rightValue)
        || compareScalar(leftPart.length, rightPart.length);
    } else {
      comparison = leftNumeric ? -1 : rightNumeric ? 1 : compareScalar(leftPart, rightPart);
    }
    if (comparison !== 0) return comparison;
  }
  return compareScalar(leftParts.length, rightParts.length);
}

function compareNativeCodexVersions(left: string, right: string): number {
  const leftVersion = parseNativeCodexVersion(left);
  const rightVersion = parseNativeCodexVersion(right);
  if (leftVersion === null || rightVersion === null) return compareScalar(left, right);
  for (let index = 0; index < leftVersion.core.length; index += 1) {
    const comparison = compareScalar(leftVersion.core[index] ?? 0n, rightVersion.core[index] ?? 0n);
    if (comparison !== 0) return comparison;
  }
  return compareNativePrerelease(leftVersion.prerelease, rightVersion.prerelease)
    || compareNativeBuild(leftVersion.build, rightVersion.build);
}

/** A Codex plugin manifest is authoritative only for the expected plugin and one raw valid version. */
export interface CodexPluginManifestIdentity {
  readonly name: string;
  readonly version: string;
}

export function codexPluginManifestIdentity(
  value: unknown,
  expectedName: string,
): CodexPluginManifestIdentity | null {
  const record = plainRecord(value);
  const version = codexVersionIdentity(record?.["version"]);
  return record?.["name"] === expectedName && version !== null
    ? { name: expectedName, version }
    : null;
}

function hasIdentityControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) end -= 1;
  return end === value.length ? value : value.slice(0, end);
}

function normalizeGitSource(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/, "$1");
  return trimTrailingSlashes(normalized).replace(/\.git$/, "");
}

function isSemctxSource(value: unknown): boolean {
  const normalized = normalizeGitSource(value);
  return normalized === "hoklims/semctx" || normalized === "https://github.com/hoklims/semctx";
}

function isValidClaudeSourceIdentity(kind: unknown, value: unknown): value is string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || hasIdentityControlCharacter(value)
  ) return false;
  return kind === "github" || kind === "git";
}

function hasExplicitGitTransport(value: string): boolean {
  return /^(?:https?|git|ssh):\/\//i.test(value)
    || /^[^/@\s]+@[^:\s]+:/.test(value);
}

export function isCanonicalClaudeMarketplaceSource(kind: unknown, value: unknown): boolean {
  if (!isValidClaudeSourceIdentity(kind, value)) return false;
  if (kind === "github") return normalizeGitSource(value) === "hoklims/semctx";
  if (kind !== "git") return false;
  return hasExplicitGitTransport(value) && isSemctxSource(value);
}

interface ClaudeMarketplaceSourceFields {
  sourceKind?: unknown;
  source?: unknown;
  repo?: unknown;
  path?: unknown;
}

function claudeMarketplaceSourceIdentity(
  marketplace: ClaudeMarketplaceSourceFields,
): { kind: unknown; value: unknown } | null {
  const hasSourceKind = Object.prototype.hasOwnProperty.call(marketplace, "sourceKind");
  const hasSource = Object.prototype.hasOwnProperty.call(marketplace, "source");
  if (hasSourceKind || hasSource) {
    const sourceKind = hasSourceKind ? rawText(marketplace.sourceKind) : null;
    const legacyKind = hasSource ? rawText(marketplace.source) : null;
    if (hasSourceKind && sourceKind === null) return null;
    if (hasSource && legacyKind === null) return null;
    if (sourceKind !== null && legacyKind !== null && sourceKind !== legacyKind) return null;
    const explicitKind = sourceKind ?? legacyKind;
    if (explicitKind === null) return null;
    return {
      kind: explicitKind,
      value: explicitKind === "directory" ? marketplace.path : marketplace.repo,
    };
  }
  // Claude 2.1's older list shape omitted the kind and exposed only `repo`. Interpret exactly that
  // shape as Git when it has an explicit transport, otherwise as GitHub shorthand. The shared raw
  // matcher still rejects whitespace, controls, relative Git spellings and unknown kinds.
  if (marketplace.path === undefined && marketplace.repo !== undefined) {
    const kind = typeof marketplace.repo === "string" && hasExplicitGitTransport(marketplace.repo)
      ? "git"
      : "github";
    return { kind, value: marketplace.repo };
  }
  return null;
}

export function isCanonicalClaudeMarketplaceRecord(
  marketplace: ClaudeMarketplaceSourceFields,
): boolean {
  const identity = claudeMarketplaceSourceIdentity(marketplace);
  return identity !== null
    && isCanonicalClaudeMarketplaceSource(identity.kind, identity.value);
}

interface RawTraversalEntry {
  path: string;
  exists: boolean;
  dev?: number;
  ino?: number;
  mode?: number;
}

interface RawTraversalObservation {
  candidate: string;
  allowRelative: boolean;
  endpointKind: "any" | "directory";
  snapshot: readonly RawTraversalEntry[];
}

function captureRawTraversal(
  candidate: string,
  allowRelative: boolean,
  endpointKind: "any" | "directory" = "any",
): RawTraversalEntry[] | null {
  const parsed = parse(candidate);
  const absolute = isAbsolute(candidate);
  if (!absolute && !allowRelative) return null;
  const tail = absolute ? candidate.slice(parsed.root.length) : candidate;
  const separator = process.platform === "win32" ? /[\\/]/ : "/";
  const components = tail.split(separator).filter((component) => component.length > 0);
  const hasTrailingSeparator = process.platform === "win32"
    ? /[\\/]$/.test(candidate)
    : candidate.endsWith("/");

  let current = absolute ? parsed.root : process.cwd();
  const observations: RawTraversalEntry[] = [];
  const observe = (path: string, requireDirectory: boolean, allowMissing: boolean): boolean => {
    try {
      const stats = lstatSync(path);
      if (stats.isSymbolicLink() || (requireDirectory && !stats.isDirectory())) return false;
      observations.push({ path, exists: true, dev: stats.dev, ino: stats.ino, mode: stats.mode });
      return true;
    } catch (cause) {
      const missing = cause !== null && typeof cause === "object" && "code" in cause
        && (cause as { code?: unknown }).code === "ENOENT";
      if (!missing || !allowMissing) return false;
      observations.push({ path, exists: false });
      return true;
    }
  };

  if (components.length === 0) {
    return observe(current, true, false) ? observations : null;
  }
  let parentComponentsRemaining = components.filter((component) => component === "..").length;
  for (let index = 0; index < components.length; index += 1) {
    const component = components[index] ?? "";
    if (component === ".") {
      if (!observe(current, true, false)) return null;
      continue;
    }
    if (component === "..") {
      parentComponentsRemaining -= 1;
      if (!observe(current, true, false)) return null;
      current = dirname(current);
      continue;
    }
    current = join(current, component);
    const requireDirectory = index < components.length - 1
      || hasTrailingSeparator
      || endpointKind === "directory";
    if (!observe(current, requireDirectory, parentComponentsRemaining === 0)) return null;
    if (observations.at(-1)?.exists === false) return observations;
  }
  return observations;
}

function sameRawTraversal(
  candidate: string,
  allowRelative: boolean,
  endpointKind: "any" | "directory",
  before: readonly RawTraversalEntry[],
): boolean {
  const after = captureRawTraversal(candidate, allowRelative, endpointKind);
  return after !== null
    && after.length === before.length
    && before.every((entry, index) => {
      const current = after[index];
      return current !== undefined
        && current.path === entry.path
        && current.exists === entry.exists
        && current.dev === entry.dev
        && current.ino === entry.ino
        && current.mode === entry.mode;
    });
}

function hasLocalFilesystemShape(candidate: string): boolean {
  if (!isAbsolute(candidate) || hasIdentityControlCharacter(candidate)) return false;
  if (process.platform === "win32") return /^[A-Za-z]:[\\/]/.test(candidate);
  return !candidate.startsWith("//") && !candidate.includes("\\");
}

function hasExplicitTraversalSegment(candidate: string): boolean {
  const parsed = parse(candidate);
  const tail = candidate.slice(parsed.root.length);
  const components = process.platform === "win32" ? tail.split(/[\\/]/) : tail.split("/");
  return components.some((component) => component === "." || component === "..");
}

function hasLocalRepositoryRootShape(candidate: string): boolean {
  if (hasIdentityControlCharacter(candidate)) return false;
  if (isAbsolute(candidate)) return hasLocalFilesystemShape(candidate);
  if (process.platform === "win32") {
    return !/^[\\/]/.test(candidate) && !/^[A-Za-z]:/.test(candidate);
  }
  return !candidate.includes("\\");
}

function observeRawTraversal(
  candidate: string,
  allowRelative: boolean,
  endpointKind: "any" | "directory",
  observations: RawTraversalObservation[],
): boolean {
  const snapshot = captureRawTraversal(candidate, allowRelative, endpointKind);
  if (snapshot === null) return false;
  observations.push({ candidate, allowRelative, endpointKind, snapshot });
  return true;
}

/**
 * A UNC or Win32 device path handed back by a host is not a local read: touching
 * `\\<host>\share` makes Windows open an SMB connection, which is network egress from a product
 * path, a multi-second stall, and an NTLM authentication attempt against whoever answers. Reject
 * the shape before any filesystem call can see it.
 */
export function isLocalFilesystemPath(candidate: string): boolean {
  return hasLocalFilesystemShape(candidate) && captureRawTraversal(candidate, false) !== null;
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
  if (!hasLocalFilesystemShape(candidate) || !hasLocalFilesystemShape(home)) return null;

  const resolvedCandidate = resolve(candidate);
  const resolvedHome = resolve(home);
  // Dependency-injected tests use virtual paths. Real host paths, however, must be canonicalized so
  // a junction or symlink cannot escape the lexical home after this check. Probe only the trusted
  // home first; never touch the complete untrusted candidate to decide whether it exists.
  let canonicalHome: string;
  try {
    canonicalHome = realpathSync.native(resolvedHome);
  } catch {
    if (!isWithin(resolvedCandidate, resolvedHome)) return null;
    return captureRawTraversal(candidate, false) === null ? null : resolvedCandidate;
  }
  if (!isWithin(resolvedCandidate, resolvedHome) && !isWithin(resolvedCandidate, canonicalHome)) return null;
  if (captureRawTraversal(candidate, false) === null) return null;
  return walkExistingPathWithoutLinks(resolvedCandidate, canonicalHome, "any")?.path ?? null;
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

/**
 * The only tokens this diagnostic ever passes to a host CLI, across both queries
 * (`[host, "plugin", "marketplace", "list", "--json"]` and `[host, "plugin", "list", "--json"]`).
 * A parser rejection naming anything else is not a rejection of *this* query shape.
 */
const QUERIED_ARGUMENT_TOKENS = ["plugin", "marketplace", "list", "--json"] as const;
const QUERIED_ARGUMENT_ALTERNATION = QUERIED_ARGUMENT_TOKENS
  .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");

/**
 * Recognized command-parser rejections: the host CLI does not support this subcommand shape at
 * all, as distinct from an ordinary runtime, timeout, auth or configuration failure. Recognition is
 * closed and exact on two axes — only the tokens this diagnostic actually queried may be named, and
 * the diagnostic must be a complete parser error line by itself, not a quoted fragment sitting
 * inside a longer, generic error sentence — so only known parser-rejection diagnostics qualify, and
 * every other non-zero exit stays `HOST_QUERY_FAILED`.
 */
const HOST_INTERFACE_UNSUPPORTED_PATTERNS: readonly RegExp[] = [
  new RegExp(`^error:\\s*unknown command '(?:${QUERIED_ARGUMENT_ALTERNATION})'\\s*$`, "im"),
  new RegExp(`^error:\\s*unexpected argument '(?:${QUERIED_ARGUMENT_ALTERNATION})' found\\s*$`, "im"),
  new RegExp(`^error:\\s*unrecognized subcommand '(?:${QUERIED_ARGUMENT_ALTERNATION})'\\s*$`, "im"),
];

/**
 * Whether a failed command outcome is a recognized host-CLI parser rejection rather than a generic
 * failure. Pure and dependency-free so installer parity (`apps/cli/src/commands/install.ts`) can
 * share the exact same recognition instead of re-deriving it.
 */
export function isHostInterfaceUnsupportedFailure(outcome: {
  code: number;
  out: string;
  err: string;
}): boolean {
  if (outcome.code === 0) return false;
  // Normalize CRLF so the `^`/`$` line anchors work identically on Windows and POSIX hosts.
  const text = `${outcome.out}\n${outcome.err}`.replace(/\r\n/g, "\n");
  return HOST_INTERFACE_UNSUPPORTED_PATTERNS.some((pattern) => pattern.test(text));
}

function readHostQueries(
  host: PluginDeliveryHost,
  cwd: string,
  dependencies: PluginDeliveryDependencies,
): HostQueries | PluginDeliveryReason {
  if (host === "codex" && dependencies.readCodexPluginMetadata !== undefined) {
    const inventory = dependencies.readCodexPluginMetadata(cwd);
    if (inventory === null) return "HOST_QUERY_FAILED";
    return validateHostInventory(host, inventory.marketplaces, inventory.plugins);
  }
  if (host === "claude" && dependencies.readClaudePluginMetadata !== undefined) {
    const inventory = dependencies.readClaudePluginMetadata(cwd);
    if (inventory === null) return "HOST_QUERY_FAILED";
    return validateHostInventory(host, inventory.marketplaces, inventory.plugins);
  }
  const limits = { timeoutMs: PLUGIN_DELIVERY_QUERY_TIMEOUT_MS, maxBytes: PLUGIN_DELIVERY_MAX_HOST_OUTPUT_BYTES };
  const marketplacesResult = dependencies.runQuery(
    [host, "plugin", "marketplace", "list", "--json"],
    cwd,
    limits,
  );
  const marketplacesBound = boundedFailure(marketplacesResult);
  if (marketplacesBound !== null) return marketplacesBound;
  if (marketplacesResult.code !== 0) {
    return isHostInterfaceUnsupportedFailure(marketplacesResult)
      ? "HOST_INTERFACE_UNSUPPORTED"
      : "HOST_QUERY_FAILED";
  }
  const pluginsResult = dependencies.runQuery([host, "plugin", "list", "--json"], cwd, limits);
  const pluginsBound = boundedFailure(pluginsResult);
  if (pluginsBound !== null) return pluginsBound;
  if (pluginsResult.code !== 0) {
    return isHostInterfaceUnsupportedFailure(pluginsResult)
      ? "HOST_INTERFACE_UNSUPPORTED"
      : "HOST_QUERY_FAILED";
  }

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

  return validateHostInventory(host, marketplaceList, pluginList);
}

function validateHostInventory(
  host: PluginDeliveryHost,
  marketplaceList: unknown[],
  pluginList: unknown[],
): HostQueries | PluginDeliveryReason {
  // An unidentifiable entry might be Semctx: dropping it cannot prove absence.
  const marketplaceEntries = objectEntries(marketplaceList);
  const pluginEntries = objectEntries(pluginList);
  if (marketplaceEntries.length !== marketplaceList.length
    || pluginEntries.length !== pluginList.length
    || marketplaceEntries.some((entry) => typeof entry["name"] !== "string" || entry["name"].trim() === "")
    || pluginEntries.some((entry) => host === "codex"
      ? typeof entry["pluginId"] !== "string" || entry["pluginId"].trim() === "" || typeof entry["installed"] !== "boolean"
      : typeof entry["id"] !== "string" || entry["id"].trim() === "" || typeof entry["scope"] !== "string" || entry["scope"].trim() === "")) {
    return "HOST_OUTPUT_MALFORMED";
  }

  return { marketplaces: marketplaceList, plugins: pluginList };
}

/**
 * `configured` defaults to `null` — unavailable, never observed — because most callers reach this
 * before a valid marketplace inventory exists. The one legitimate `false` (a real, successfully
 * read, empty inventory) is set explicitly by the caller that proved it.
 */
function emptyHost(requested: boolean, detected: boolean): HostPluginDeliveryV2 {
  return {
    requested,
    detected,
    marketplace: { name: MARKETPLACE_NAME, configured: null, source: null, ref: null, matchesSemctx: null },
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
  publicRelease: PublicReleaseV2,
  publicReleaseBundles: Record<string, string | null> | null,
  dependencies: PluginDeliveryDependencies,
): HostPluginDeliveryV2 {
  if (dependencies.findHostExecutable !== undefined) {
    if (dependencies.findHostExecutable(host) === null) {
      const report = emptyHost(true, false);
      report.reasons = ["HOST_NOT_DETECTED"];
      return report;
    }
  } else {
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
    // A successfully read, empty inventory *proves* the marketplace is not configured — this is the
    // one path allowed to report `false` rather than `null`.
    report.marketplace.configured = false;
    if (host === "codex") {
      // The declarative reader also observes physical caches without a registration. Preserve that
      // confined evidence without inferring enablement, approved content or session activation.
      const orphan = objectEntries(queries.plugins).find((entry) => entry["pluginId"] === CODEX_PLUGIN_ID
        && entry["installed"] === true && entry["registered"] === false);
      if (orphan !== undefined) {
        const reportedPath = rawText(orphan["cachePath"]);
        const cachePath = acceptHostPath(reportedPath, home);
        if (reportedPath !== null && cachePath === null) reasons.push("HOST_PATH_REJECTED");
        if (cachePath !== null) {
          report.installed.installed = true;
          report.installed.path = safeText(cachePath);
          report.installed.version = safeText(orphan["version"]);
          reasons.push("PLUGIN_ENABLEMENT_UNKNOWN", "INSTALLED_CACHE_CONTENT_UNPROVEN");
        }
      }
    }
    report.reasons = sortedUnique([...reasons, "MARKETPLACE_NOT_CONFIGURED"]);
    report.verdict = "UNKNOWN";
    return report;
  }
  report.marketplace.configured = true;

  const claudeSourceIdentity = host === "claude"
    ? claudeMarketplaceSourceIdentity(marketplace)
    : null;
  const rawHostSource = host === "codex"
    ? rawText((marketplace["marketplaceSource"] as { source?: unknown } | undefined)?.source)
    : rawText(claudeSourceIdentity?.value);
  report.marketplace.source = safeText(rawHostSource);
  report.marketplace.matchesSemctx = host === "claude"
    ? isCanonicalClaudeMarketplaceRecord(marketplace)
    : plainRecord(marketplace["marketplaceSource"])?.["sourceType"] === "git" && isSemctxSource(rawHostSource);
  if (report.marketplace.matchesSemctx !== true) reasons.push("MARKETPLACE_SOURCE_MISMATCH");

  const reportedRoot = host === "codex"
    ? rawText(marketplace["root"])
    : rawText(marketplace["installLocation"]);
  const marketplaceRoot = acceptHostPath(reportedRoot, home);
  if (reportedRoot !== null && marketplaceRoot === null) reasons.push("HOST_PATH_REJECTED");
  report.snapshot.path = safeText(marketplaceRoot);

  let snapshot = marketplaceRoot === null
    ? null
    : dependencies.readMarketplaceSnapshot(host, marketplaceRoot);
  if (host === "codex" && snapshot?.pluginIdentity?.name !== CODEX_PLUGIN) snapshot = null;
  const configuredCodexRef = host === "codex" ? rawText(marketplace["ref"]) : null;
  const fallbackCodexRef = host === "codex" && snapshot !== null && snapshot.sourceType === undefined
    ? rawText(snapshot.ref)
    : null;
  if (configuredCodexRef !== null && fallbackCodexRef !== null
    && configuredCodexRef !== fallbackCodexRef) {
    reasons.push("MARKETPLACE_REF_UNEXPECTED");
    snapshot = null;
  }
  if (host === "codex" && snapshot?.sourceType !== undefined) {
    const configured = plainRecord(marketplace["marketplaceSource"]);
    const expected = codexMarketplaceIdentity(configured?.["sourceType"], configured?.["source"],
      marketplace["ref"], marketplace["sparsePaths"] === undefined ? [] : marketplace["sparsePaths"]);
    const observed = codexMarketplaceIdentity(snapshot.sourceType, snapshot.source, snapshot.ref,
      snapshot.sparsePaths === undefined ? [] : snapshot.sparsePaths);
    if (expected === null || observed === null || !sameCodexMarketplaceIdentity(expected, observed)) snapshot = null;
  }
  const snapshotVersion = host === "codex" && snapshot?.pluginIdentity?.name === CODEX_PLUGIN
    ? snapshot.pluginIdentity.version
    : host === "codex" ? null : safeText(snapshot?.version);
  if (snapshot === null) {
    reasons.push("SNAPSHOT_UNREADABLE");
  } else {
    report.snapshot.commit = safeText(snapshot.commit);
    report.snapshot.version = safeText(snapshotVersion);
    if (report.snapshot.commit === null) reasons.push("SNAPSHOT_COMMIT_UNKNOWN");
    if (report.snapshot.version === null) reasons.push("SNAPSHOT_VERSION_UNKNOWN");
  }

  // Claude reports the tracked ref directly; Codex records it in the snapshot install metadata.
  const ref = host === "codex" ? configuredCodexRef ?? rawText(snapshot?.ref)
    : safeText(marketplace["ref"]) ?? safeText(snapshot?.ref) ?? null;
  report.marketplace.ref = safeText(ref);
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
  // Host JSON is untrusted, and a missing field is not proof of `false`: only a boolean the host
  // actually reported counts as known, everything else stays an unprovable `null`.
  const enabledRaw = installedEntry?.["enabled"];
  const enablementScope = installedEntry?.["enablementScope"];
  report.installed.enabled = typeof enabledRaw === "boolean" ? enabledRaw : null;
  if (report.installed.enabled === false) reasons.push("PLUGIN_DISABLED");
  else if (report.installed.enabled === null) reasons.push("PLUGIN_ENABLEMENT_UNKNOWN");

  const rawHostVersion = rawText(installedEntry?.["version"]);
  // `source.path` is the approved marketplace snapshot, never the executed cache entry.
  const reportedCachePath = host === "codex"
    ? rawText(installedEntry?.["cachePath"]) ?? (marketplaceRoot === null || rawHostVersion === null
      ? null
      : codexCacheEntryFromMarketplaceRoot(marketplaceRoot, rawHostVersion, home))
    : rawText(installedEntry?.["installPath"]);
  const cachePath = acceptHostPath(reportedCachePath, home);
  if (reportedCachePath !== null && cachePath === null) reasons.push("HOST_PATH_REJECTED");
  report.installed.path = safeText(cachePath);

  const payload = cachePath === null ? null : dependencies.readInstalledPayload(host, cachePath);
  const cacheVersion = host === "codex" ? payload?.pluginIdentity?.version ?? null : safeText(payload?.version);
  // The payload readback cannot replace the version admitted by inventory. `local` is a
  // directory identity, so compare declared versions rather than the cache path's basename.
  if (payload === null || cacheVersion === null || (host === "codex"
    && (payload.pluginIdentity?.name !== CODEX_PLUGIN || cacheVersion !== rawHostVersion))) {
    report.reasons = sortedUnique([...reasons, "INSTALLED_CACHE_UNREADABLE"]);
    report.verdict = "UNKNOWN";
    return report;
  }
  report.installed.version = safeText(cacheVersion);

  if (snapshotVersion !== null && cacheVersion !== snapshotVersion) {
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
  const sessionVersion = host === "codex" ? codexVersionIdentity(session.version) : safeText(session.version);
  report.session = {
    status: session.status,
    version: safeText(sessionVersion),
    reason: safeText(session.reason),
  };
  if (report.session.status !== "observed" || sessionVersion === null) {
    reasons.push("SESSION_VERSION_UNOBSERVABLE");
  } else if (sessionVersion !== cacheVersion) {
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
    const userEnableCanConverge = enablementScope !== "project" && enablementScope !== "local";
    report.convergence = [
      ...CONVERGENCE[host].map((entry) => [...entry]),
      ...(report.installed.enabled === false && enable !== undefined && userEnableCanConverge
        ? [[...enable]]
        : []),
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
  hosts: readonly HostPluginDeliveryV2[],
  dimension: "verdict" | "delivery",
): PluginDeliveryVerdict {
  const requested = hosts.filter((host) => host.requested);
  if (requested.length === 0) return "UNKNOWN";
  if (requested.some((host) => host[dimension] === "UNKNOWN")) return "UNKNOWN";
  if (requested.some((host) => host[dimension] === "UPDATE_AVAILABLE")) return "UPDATE_AVAILABLE";
  return "UP_TO_DATE";
}

function nextSteps(
  report: Omit<PluginDeliveryReportV2, "next">,
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
    // A recognized parser rejection means the installed CLI cannot run the commands this report
    // needs at all — recommending the ordinary convergence commands here would repeat the same
    // rejection; the actionable remedy is upgrading the host CLI itself.
    if (state.reasons.includes("HOST_INTERFACE_UNSUPPORTED")) {
      next.push(
        `${label}'s CLI does not support the plugin commands semctx needs; update ${label} to a`
          + " version with plugin support, then re-run",
      );
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
): PluginDeliveryReportV2 {
  // Every default is bound to the resolved query seam, so a test that injects `runQuery` observes
  // the Git reads too and the read-only guarantee is provable, not merely asserted.
  const runQuery = dependencies.runQuery ?? runPluginDeliveryQuery;
  const findHostExecutable = dependencies.findHostExecutable
    ?? (dependencies.runQuery === undefined ? (host: PluginDeliveryHost) => Bun.which(host) : undefined);
  const resolveHostHome = dependencies.resolveHostHome ?? defaultResolveHostHome;
  const resolveAttestationExclusionHome = dependencies.resolveHostHome
    ?? defaultResolveHostExclusionHome;
  const readClaudePluginMetadata = dependencies.readClaudePluginMetadata
    ?? (dependencies.runQuery === undefined
      ? (root: string) => {
          const home = resolveHostHome("claude");
          return home === null ? null : readClaudePluginMetadataInventory(root, home);
        }
      : undefined);
  const readCodexPluginMetadata = dependencies.readCodexPluginMetadata
    ?? (dependencies.runQuery === undefined
      ? (_root: string) => {
          const home = resolveHostHome("codex");
          return home === null ? null : readCodexPluginMetadataInventory(_root, home);
        }
      : undefined);
  const resolved: PluginDeliveryDependencies = {
    runQuery,
    ...(findHostExecutable === undefined ? {} : { findHostExecutable }),
    ...(readCodexPluginMetadata === undefined ? {} : { readCodexPluginMetadata }),
    ...(readClaudePluginMetadata === undefined ? {} : { readClaudePluginMetadata }),
    readMarketplaceSnapshot: dependencies.readMarketplaceSnapshot
      ?? ((host, root) => defaultReadMarketplaceSnapshot(host, root, runQuery)),
    readInstalledPayload: dependencies.readInstalledPayload ?? defaultReadInstalledPayload,
    readRepositoryChannel: dependencies.readRepositoryChannel
      ?? ((root) => defaultReadRepositoryChannel(root, runQuery)),
    resolvePublicRelease: dependencies.resolvePublicRelease
      ?? ((root) => defaultResolvePublicRelease(
        root,
        runQuery,
        command.attest === true,
        resolveAttestationExclusionHome,
      )),
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
  const publicRelease: PublicReleaseV2 = {
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

  const partial: Omit<PluginDeliveryReportV2, "next"> = {
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

export function runPluginDeliveryQuery(
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
  if (host === "claude") return resolveClaudePluginHome(process.env["CLAUDE_CONFIG_DIR"]);
  let home: string;
  try {
    home = homedir();
  } catch {
    return null;
  }
  if (host === "codex") {
    const configured = process.env["CODEX_HOME"];
    if (typeof configured === "string" && configured.trim().length > 0) {
      const candidate = configured;
      return isLocalFilesystemPath(candidate) ? candidate : null;
    }
  }
  if (!isLocalFilesystemPath(home)) return null;
  // Preserve cancelled components from the OS home until the inventory's two snapshots record
  // their identities. join/resolve here would erase an ancestor that can drift during the read.
  const separator = home.endsWith("/") || home.endsWith("\\") ? "" : sep;
  return `${home}${separator}.codex`;
}

/**
 * Resolve the raw profile spelling that an attestation scratch directory must exclude.
 *
 * Inventory reads deliberately reject links and reparse points. Exclusion has the opposite safety
 * obligation: retain an otherwise local alias so the scratch planner can compare both its lexical
 * and canonical targets without weakening the inventory reader or following a network path.
 */
function defaultResolveHostExclusionHome(host: PluginDeliveryHost): string | null {
  const configured = process.env[host === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"];
  if (configured !== undefined && configured.length > 0) {
    if (configured.trim().length === 0 || !hasLocalFilesystemShape(configured)) return null;
    return configured;
  }
  let home: string;
  try {
    home = homedir();
  } catch {
    return null;
  }
  if (!hasLocalFilesystemShape(home)) return null;
  const separator = home.endsWith("/") || home.endsWith("\\") ? "" : sep;
  const candidate = `${home}${separator}${host === "claude" ? ".claude" : ".codex"}`;
  return hasLocalFilesystemShape(candidate) ? candidate : null;
}

/** Resolve Claude's exact profile root without starting Claude Code. */
export function resolveClaudePluginHome(configured?: string, userHome?: string): string | null {
  if (configured !== undefined) {
    if (configured.length === 0) {
      // Claude treats an empty override as absent; use the normal profile root below.
    } else {
      // Whitespace-only and relative overrides are invalid. Do not trim a valid absolute path:
      // U+00A0 and ordinary spaces are legal filename characters and name a different profile.
      if (configured.trim().length === 0 || !isLocalFilesystemPath(configured)) return null;
      return configured;
    }
  }
  let home = userHome;
  if (home === undefined) {
    try {
      home = homedir();
    } catch {
      return null;
    }
  }
  return isLocalFilesystemPath(home) ? resolve(join(home, ".claude")) : null;
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
    if (!hasLocalFilesystemShape(candidate) || !hasLocalFilesystemShape(root)) return null;
    // The root is trusted enough to inspect, but its raw spelling still matters: resolving first
    // would erase a linked or non-directory component followed by `..`. Validate that lineage
    // before canonicalization. Candidate inspection remains deferred until containment is proven.
    if (captureRawTraversal(root, false) === null) return null;
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
    if (captureRawTraversal(candidate, false) === null) return null;
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

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function decodeMetadataObject(bytes: Buffer | null): Record<string, unknown> | null {
  if (bytes === null) return null;
  const parsed = parseJsonValue(bytes.toString("utf8"));
  return plainRecord(parsed);
}

function decodeCodexUtf8(bytes: Buffer): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** JSON syntax is already validated; retain decoded keys that JSON.parse otherwise overwrites. */
function codexJsonStringsAreUnambiguous(text: string): boolean {
  const scopes: ({ keys: Set<string>; awaitingKey: boolean } | null)[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "{") scopes.push({ keys: new Set(), awaitingKey: true });
    else if (character === "[") scopes.push(null);
    else if (character === "}" || character === "]") scopes.pop();
    else if (character === "," || character === ":") {
      const scope = scopes.at(-1);
      if (scope !== undefined && scope !== null) scope.awaitingKey = character === ",";
    } else if (character === '"') {
      const start = index;
      for (index += 1; index < text.length; index += 1) {
        if (text[index] === "\\") index += 1;
        else if (text[index] === '"') break;
      }
      const value = parseJsonValue(text.slice(start, index + 1));
      if (typeof value !== "string") return false;
      // Iteration joins valid UTF-16 pairs into one code point; a remaining surrogate is invalid.
      for (const scalar of value) {
        const code = scalar.codePointAt(0) ?? 0;
        if (code >= 0xd800 && code <= 0xdfff) return false;
      }
      const scope = scopes.at(-1);
      if (scope !== undefined && scope !== null && scope.awaitingKey) {
        if (scope.keys.has(value)) return false;
        scope.keys.add(value);
      }
    }
  }
  return scopes.length === 0;
}

function decodeCodexMetadataObject(bytes: Buffer | null): Record<string, unknown> | null {
  if (bytes === null) return null;
  const text = decodeCodexUtf8(bytes);
  if (text === null) return null;
  const parsed = plainRecord(parseJsonValue(text));
  return parsed !== null && codexJsonStringsAreUnambiguous(text) ? parsed : null;
}

/** Shared descriptor-bound Codex JSON reader for manifest consumers, including installer recovery. */
export function readCodexMetadataObject(file: string, root: string): Record<string, unknown> | null {
  return decodeCodexMetadataObject(readConfinedFile(file, root, PLUGIN_DELIVERY_MAX_MANIFEST_BYTES));
}

type OptionalMetadataFile =
  | { status: "absent" }
  | { status: "unsafe" }
  | { status: "ok"; bytes: Buffer };

/** Distinguish a proven absent file from an unsafe path; `readConfinedFile` intentionally cannot. */
function readOptionalMetadataFile(
  file: string, root: string, maxBytes = PLUGIN_DELIVERY_MAX_HOST_OUTPUT_BYTES,
): OptionalMetadataFile {
  try {
    const resolvedRoot = resolve(root);
    const resolvedFile = resolve(file);
    // Bun 1.4's POSIX `node:fs` compatibility layer treats a literal backslash as a separator.
    // It therefore cannot safely prove either presence or absence for this legal POSIX filename.
    // Refuse the observation rather than misreporting an empty profile or reopening it through an
    // unconfined external process.
    if (process.platform !== "win32" && resolvedFile.includes("\\")) {
      return { status: "unsafe" };
    }
    if (!isWithin(resolvedFile, resolvedRoot)) return { status: "unsafe" };
    const anchor = parse(resolvedRoot).root;
    let current = anchor;
    const components = relative(anchor, resolvedFile).split(sep).filter(Boolean);
    for (let index = -1; index < components.length; index += 1) {
      if (index >= 0) current = join(current, components[index] ?? "");
      let stats;
      try {
        stats = lstatSync(current);
      } catch (cause) {
        return cause !== null && typeof cause === "object" && "code" in cause
            && (cause as { code?: unknown }).code === "ENOENT"
          ? { status: "absent" }
          : { status: "unsafe" };
      }
      if (stats.isSymbolicLink()) return { status: "unsafe" };
      const final = index === components.length - 1;
      if (!final && !stats.isDirectory()) return { status: "unsafe" };
      if (final && !stats.isFile()) return { status: "unsafe" };
    }
    const bytes = readConfinedFile(file, root, maxBytes);
    return bytes === null ? { status: "unsafe" } : { status: "ok", bytes };
  } catch {
    return { status: "unsafe" };
  }
}

function sameOptionalObservation(before: OptionalMetadataFile, after: OptionalMetadataFile): boolean {
  if (before.status !== after.status) return false;
  return before.status !== "ok" || (after.status === "ok" && before.bytes.equals(after.bytes));
}

/** The subset of Codex's config and cache inventory needed by install and plugin-status. */
export interface CodexPluginMetadataInventory {
  marketplaces: Record<string, unknown>[];
  plugins: Record<string, unknown>[];
}

interface CodexConfigTables {
  marketplaces: Record<string, unknown>;
  plugins: Record<string, unknown>;
  projects: Record<string, unknown>;
}

const CODEX_ENTRY_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const CODEX_CACHE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,127}$/;
const MAX_CODEX_ENTRIES = 256;
const CODEX_INACTIVE_PROFILE_FIELDS = new Set([
  "model",
  "model_reasoning_effort",
  "model_reasoning_summary",
  "model_verbosity",
  "service_tier",
]);
const CODEX_HOME_MARKETPLACE_MANIFESTS = [
  [".agents", "plugins", "marketplace.json"],
  [".agents", "plugins", "api_marketplace.json"],
  [".claude-plugin", "marketplace.json"],
  [".cursor-plugin", "marketplace.json"],
] as const;

function codexTomlTable(value: unknown): Record<string, unknown> | null {
  const record = plainRecord(value);
  if (record === null) return null;
  const prototype: unknown = Object.getPrototypeOf(record);
  // TOML datetimes are scalar Date values in Bun; only actual tables merge recursively.
  return prototype === Object.prototype || prototype === null ? record : null;
}

/** Pinned generic TOML merge for supported plugin metadata: tables recurse, other values replace. */
function mergeCodexTomlTables(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const copy = (table: Record<string, unknown>): Record<string, unknown> =>
    Object.assign(Object.create(null) as Record<string, unknown>, table);
  const result = copy(base);
  const pending = [{ base, overlay, result }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    for (const [key, value] of Object.entries(current.overlay)) {
      const lower = codexTomlTable(current.base[key]);
      const higher = codexTomlTable(value);
      if (lower !== null && higher !== null) {
        const result = copy(lower);
        current.result[key] = result;
        pending.push({ base: lower, overlay: higher, result });
      } else current.result[key] = value;
    }
  }
  return result;
}

function validCodexProjects(projects: Record<string, unknown>): boolean {
  return Object.values(projects).every((raw) => {
    const project = codexTomlTable(raw);
    return project !== null && (project["trust_level"] === undefined
      || project["trust_level"] === "trusted" || project["trust_level"] === "untrusted");
  });
}

function validInactiveCodexProfiles(raw: unknown): boolean {
  const profiles = codexTomlTable(raw);
  if (profiles === null || Object.keys(profiles).length > MAX_CODEX_ENTRIES) return false;
  return Object.values(profiles).every((rawProfile) => {
    const profile = codexTomlTable(rawProfile);
    return profile !== null && Object.entries(profile).every(([key, value]) =>
      CODEX_INACTIVE_PROFILE_FIELDS.has(key) && typeof value === "string");
  });
}

function parseCodexConfig(observation: OptionalMetadataFile): Record<string, unknown> | null {
  if (observation.status === "unsafe") return null;
  if (observation.status === "absent") return {};
  let config: Record<string, unknown> | null;
  const text = decodeCodexUtf8(observation.bytes);
  if (text === null) return null;
  try {
    config = codexTomlTable(Bun.TOML.parse(text));
  } catch {
    return null;
  }
  if (config === null) return null;
  // Bare plugin commands do not select a profile. A separately selected profile cannot be
  // reconstructed from this metadata-only boundary and must not be treated as the user layer.
  if (config["profile"] !== undefined || config["project_root_markers"] !== undefined) return null;
  if (config["profiles"] !== undefined) {
    if (!validInactiveCodexProfiles(config["profiles"])) return null;
    delete config["profiles"];
  }
  return config;
}

function effectiveCodexConfigTables(config: Record<string, unknown>): CodexConfigTables | null {
  const features = config["features"] === undefined ? {} : codexTomlTable(config["features"]);
  if (features === null || features["plugins"] === false
    || (features["plugins"] !== undefined && typeof features["plugins"] !== "boolean")) return null;
  const marketplaces = config["marketplaces"] === undefined ? {} : codexTomlTable(config["marketplaces"]);
  const plugins = config["plugins"] === undefined ? {} : codexTomlTable(config["plugins"]);
  const projects = config["projects"] === undefined ? {} : codexTomlTable(config["projects"]);
  if (marketplaces === null || plugins === null || projects === null
    || Object.keys(marketplaces).length > MAX_CODEX_ENTRIES
    || Object.keys(plugins).length > MAX_CODEX_ENTRIES) return null;
  if (!validCodexProjects(projects)) return null;
  return { marketplaces, plugins, projects };
}

interface CodexCachedVersion { directory: string; version: string }

function observeCodexLatestAlias(
  alias: string,
  selectedRoot: string,
  observations: string[],
): boolean {
  try {
    const before = lstatSync(alias);
    if (!before.isSymbolicLink()) return false;
    const beforeTarget = readlinkSync(alias);
    const resolvedTarget = resolve(dirname(alias), beforeTarget);
    if (lexicalPathIdentity(resolvedTarget) !== lexicalPathIdentity(selectedRoot)
      || lexicalPathIdentity(realpathSync.native(alias)) !== lexicalPathIdentity(realpathSync.native(selectedRoot))) {
      return false;
    }
    const after = lstatSync(alias);
    const afterTarget = readlinkSync(alias);
    if (!after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino
      || after.mode !== before.mode || afterTarget !== beforeTarget
      || lexicalPathIdentity(realpathSync.native(alias)) !== lexicalPathIdentity(realpathSync.native(selectedRoot))) {
      return false;
    }
    observations.push(JSON.stringify({
      latestAlias: alias,
      target: beforeTarget,
      resolvedTarget,
      dev: before.dev,
      ino: before.ino,
      mode: before.mode,
    }));
    return true;
  } catch {
    return false;
  }
}

function readCodexMetadataFile(
  file: string, root: string, observations: string[], maxBytes = PLUGIN_DELIVERY_MAX_HOST_OUTPUT_BYTES,
): OptionalMetadataFile {
  const traversal = captureRawTraversal(file, false);
  let observed: OptionalMetadataFile = traversal === null ? { status: "unsafe" } : readOptionalMetadataFile(file, root, maxBytes);
  // Empty TOML is valid; the shared bundle/JSON reader deliberately rejects empty files. Prove
  // this case through the same physical file identity and an EOF read without widening that reader.
  if (observed.status === "unsafe" && traversal !== null && isWithin(file, root)) {
    let descriptor: number | undefined;
    try {
      const before = lstatSync(file);
      const physical = traversal.at(-1);
      if (before.isFile() && !before.isSymbolicLink() && before.size === 0
        && physical?.exists === true && before.dev === physical.dev && before.ino === physical.ino) {
        descriptor = openSync(file, "r");
        const opened = fstatSync(descriptor);
        if (opened.dev === before.dev && opened.ino === before.ino && opened.size === 0
          && readSync(descriptor, Buffer.alloc(1), 0, 1, 0) === 0
          && fstatSync(descriptor).size === 0) observed = { status: "ok", bytes: Buffer.alloc(0) };
      }
    } catch { /* The empty-file observation remains unsafe. */ }
    finally {
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch { observed = { status: "unsafe" }; }
      }
    }
  }
  observations.push(JSON.stringify({
    file, traversal, status: observed.status,
    digest: observed.status === "ok" ? createHash("sha256").update(observed.bytes).digest("hex") : null,
  }));
  return observed;
}

function readCodexCachedVersion(
  home: string, marketplace: string, plugin: string, observations: string[],
): CodexCachedVersion | null | false {
  const root = join(home, "plugins", "cache", marketplace, plugin);
  const traversal = captureRawTraversal(root, false, "directory");
  if (!hasLocalFilesystemShape(root) || traversal === null) return false;
  observations.push(JSON.stringify({ cacheRoot: root, traversal }));
  let entries: Dirent[];
  try {
    const stats = lstatSync(root);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
    entries = readdirSync(root, { withFileTypes: true });
  } catch (cause) {
    return cause !== null && typeof cause === "object" && "code" in cause
      && (cause as { code?: unknown }).code === "ENOENT" ? null : false;
  }
  if (entries.length > MAX_CODEX_ENTRIES
    || !sameRawTraversal(root, false, "directory", traversal)) return false;
  observations.push(JSON.stringify({ root, traversal: captureRawTraversal(root, false, "directory"), entries: entries.map((entry) => ({
    name: entry.name, directory: entry.isDirectory(), file: entry.isFile(), link: entry.isSymbolicLink(),
  })).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0) }));
  const versions: Array<{ directory: string; root: string }> = [];
  let latestAlias: string | null = null;
  for (const entry of entries) {
    if (entry.isFile() && entry.name === ".codex-remote-plugin-install.json") {
      const metadata = readCodexMetadataFile(join(root, entry.name), home, observations);
      const value = metadata.status === "ok" ? decodeCodexMetadataObject(metadata.bytes) : null;
      if (value?.["schema_version"] !== 1
        || typeof value["remote_plugin_id"] !== "string"
        || value["remote_plugin_id"].trim().length === 0) return false;
      continue;
    }
    if (entry.isSymbolicLink()) {
      if (entry.name !== "latest" || latestAlias !== null) return false;
      latestAlias = join(root, entry.name);
      continue;
    }
    if (!entry.isDirectory() || !CODEX_CACHE_NAME.test(entry.name)) return false;
    const versionRoot = join(root, entry.name);
    const versionTraversal = captureRawTraversal(versionRoot, false, "directory");
    if (versionTraversal === null) return false;
    let versionEntries: Dirent[];
    try {
      const stats = lstatSync(versionRoot);
      if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
      versionEntries = readdirSync(versionRoot, { withFileTypes: true });
    } catch {
      return false;
    }
    if (versionEntries.length > MAX_CODEX_ENTRIES
      || !sameRawTraversal(versionRoot, false, "directory", versionTraversal)) return false;
    observations.push(JSON.stringify({
      cacheVersionRoot: versionRoot,
      traversal: versionTraversal,
      entries: versionEntries.map((child) => ({
        name: child.name,
        directory: child.isDirectory(),
        file: child.isFile(),
        link: child.isSymbolicLink(),
      })).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
    }));
    versions.push({ directory: entry.name, root: versionRoot });
  }
  if (versions.length === 0) return latestAlias === null ? null : false;
  const local = versions.find((entry) => entry.directory === "local");
  // Captured Codex 0.147.0, 0.155.1 and 0.160.0 select regular directory names first: `local`
  // wins, otherwise semver 1.0.27 Version::cmp ordering selects the last name.
  versions.sort((left, right) => compareNativeCodexVersions(left.directory, right.directory));
  const selected = local ?? versions.at(-1);
  if (selected === undefined
    || (latestAlias !== null && !observeCodexLatestAlias(latestAlias, selected.root, observations))) return false;
  const manifest = readCodexMetadataFile(
    join(selected.root, ".codex-plugin", "plugin.json"),
    home,
    observations,
  );
  if (manifest.status !== "ok") return false;
  const identity = codexPluginManifestIdentity(decodeCodexMetadataObject(manifest.bytes), plugin);
  const declared = identity?.version;
  if (identity === null || declared === undefined || !CODEX_CACHE_NAME.test(declared)
    || (selected.directory !== "local" && declared !== selected.directory)) return false;
  return { directory: selected.directory, version: declared };
}

interface CodexMarketplaceManifest {
  name: string;
  localSources: Record<string, string | null>;
}

function codexLocalSourceRoot(source: string): string | null {
  // Codex serializes Win32 local paths with this prefix. Only a drive path may be unwrapped;
  // UNC/device aliases remain rejected before any filesystem access.
  const candidate = process.platform === "win32" && /^\\\\\?\\[A-Za-z]:\\/.test(source)
    ? source.slice(4)
    : source;
  return hasLocalFilesystemShape(candidate) && !hasExplicitTraversalSegment(candidate)
    && isLocalFilesystemPath(candidate) ? resolve(candidate) : null;
}

function isCodexGitSource(source: string): boolean {
  return !hasIdentityControlCharacter(source) && !/\s/.test(source)
    && (/^(?:https?:\/\/|ssh:\/\/|git@[^:]+:)[^\s]+$/.test(source)
      || /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(source));
}

export interface CodexMarketplaceIdentity {
  sourceType: "git" | "local";
  source: string;
  ref: string | null;
  sparsePaths: readonly string[];
}

/** One native identity projection shared by configuration, sidecars and their consumers. */
export function codexMarketplaceIdentity(
  sourceType: unknown, source: unknown, ref: unknown, sparsePaths: unknown,
): CodexMarketplaceIdentity | null {
  if ((sourceType !== "git" && sourceType !== "local")
    || typeof source !== "string" || source.length === 0 || hasIdentityControlCharacter(source)
    || (sourceType === "git" && !isCodexGitSource(source))
    || (sourceType === "local" && codexLocalSourceRoot(source) === null)
    || (ref !== undefined && ref !== null
      && (typeof ref !== "string" || ref.length === 0 || /\s/.test(ref) || hasIdentityControlCharacter(ref)))
    || !Array.isArray(sparsePaths) || !sparsePaths.every((path): path is string =>
      typeof path === "string" && !path.includes("\0"))) return null;
  return { sourceType, source, ref: typeof ref === "string" ? ref : null, sparsePaths: [...sparsePaths] };
}

export function sameCodexMarketplaceIdentity(left: CodexMarketplaceIdentity, right: CodexMarketplaceIdentity): boolean {
  // Native InstalledMarketplaceMetadata derives PartialEq: Vec order and duplicates both matter.
  return left.sourceType === right.sourceType && left.source === right.source && left.ref === right.ref
    && left.sparsePaths.length === right.sparsePaths.length
    && left.sparsePaths.every((path, index) => path === right.sparsePaths[index]);
}

interface CodexMarketplaceSidecar extends CodexMarketplaceIdentity { revision: string }

function decodeCodexMarketplaceSidecar(bytes: Buffer): CodexMarketplaceSidecar | null {
  const record = decodeCodexMetadataObject(bytes);
  if (record === null) return null;
  const identity = codexMarketplaceIdentity(record["source_type"], record["source"], record["ref_name"], record["sparse_paths"]);
  const revision = record["revision"];
  if (identity === null || typeof revision !== "string"
    || (revision !== "" && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(revision))
    || (identity.sourceType === "git" && revision === "")) return null;
  return { ...identity, revision };
}

/** Absence is valid; present metadata must carry the bounded, strictly decoded native structure. */
function readCodexMarketplaceSidecar(root: string, observations: string[]): CodexMarketplaceSidecar | null | false {
  const observed = readCodexMetadataFile(join(root, ".codex-marketplace-install.json"), root, observations,
    PLUGIN_DELIVERY_MAX_MANIFEST_BYTES);
  if (observed.status === "absent") return null;
  return observed.status === "ok" ? decodeCodexMarketplaceSidecar(observed.bytes) ?? false : false;
}

/** Protect the Semctx namespace a new native marketplace add would select after an interrupted run. */
function codexCheckoutQueryLine(root: string, command: readonly string[], observations: string[]): string | null {
  const outcome = runPluginDeliveryQuery(command, root, LOCAL_READ_LIMITS);
  const bytes = outcome.bytes === undefined ? new TextEncoder().encode(outcome.out) : outcome.bytes;
  observations.push(JSON.stringify({
    checkoutQuery: command.slice(3),
    code: outcome.code,
    timedOut: outcome.timedOut === true,
    truncated: outcome.truncated === true,
    stdoutDigest: bytes === null ? null : createHash("sha256").update(bytes).digest("hex"),
  }));
  if (outcome.code !== 0 || outcome.timedOut === true || outcome.truncated === true || bytes === null) return null;
  const decoded = decodeCodexUtf8(Buffer.from(bytes));
  if (decoded === null) return null;
  const line = decoded.endsWith("\r\n") ? decoded.slice(0, -2)
    : decoded.endsWith("\n") ? decoded.slice(0, -1) : decoded;
  return line.length > 0 && !/[\r\n]/.test(line) ? line : null;
}

function codexUnregisteredCheckoutMatches(root: string, sidecar: CodexMarketplaceSidecar,
  observations: string[]): boolean {
  const prefix = ["git", "-C", root, "--no-replace-objects"] as const;
  const topLevel = codexCheckoutQueryLine(root, [...prefix, "rev-parse", "--show-toplevel"], observations);
  if (topLevel === null || !hasLocalFilesystemShape(topLevel)) return false;
  const rootTraversal = captureRawTraversal(root, false, "directory");
  const topLevelTraversal = captureRawTraversal(topLevel, false, "directory");
  observations.push(JSON.stringify({ checkoutRoot: root, rootTraversal, topLevel, topLevelTraversal }));
  if (rootTraversal === null || topLevelTraversal === null) return false;
  try {
    if (lexicalPathIdentity(realpathSync.native(root))
      !== lexicalPathIdentity(realpathSync.native(topLevel))) return false;
  } catch { return false; }
  const source = codexCheckoutQueryLine(root, [...prefix, "remote", "get-url", "origin"], observations);
  const ref = codexCheckoutQueryLine(root, [...prefix, "symbolic-ref", "--short", "HEAD"], observations);
  const revision = codexCheckoutQueryLine(root, [...prefix, "rev-parse", "HEAD"], observations);
  return source !== null && isSemctxSource(source) && isSemctxSource(sidecar.source)
    && ref === sidecar.ref && revision === sidecar.revision;
}

function codexUnregisteredSelectedSnapshotIsSafe(home: string, observations: string[]): boolean {
  const root = join(home, ...CODEX_SNAPSHOT_SEGMENTS);
  const traversal = captureRawTraversal(root, false, "directory");
  if (traversal === null) return false;
  observations.push(JSON.stringify({ unregisteredSelectedSnapshot: root, traversal }));
  const sidecar = readCodexMarketplaceSidecar(root, observations);
  if (sidecar === false) return false;
  if (traversal.at(-1)?.exists !== true) return sidecar === null;
  // Without a configuration entry, only the intended public source/stable/full checkout can be
  // resumed. This proves ownership of the selected slot; it never registers it or grants authority.
  if (sidecar === null || !isSemctxSource(sidecar.source)) return false;
  const expected = codexMarketplaceIdentity("git", sidecar.source, PLUGIN_DELIVERY_RELEASE_REF, []);
  if (expected === null || !sameCodexMarketplaceIdentity(expected, sidecar)) return false;
  const manifest = readCodexMarketplaceManifest(root, observations);
  if (manifest === null || manifest === false || manifest.name !== MARKETPLACE_NAME) return false;
  const pluginRoot = manifest.localSources[CODEX_PLUGIN];
  return typeof pluginRoot === "string"
    && lexicalPathIdentity(pluginRoot) === lexicalPathIdentity(join(root, "plugins", CODEX_PLUGIN))
    && codexUnregisteredCheckoutMatches(root, sidecar, observations);
}

function validCodexMarketplacePolicy(value: unknown): boolean {
  if (value === undefined) return true;
  const policy = plainRecord(value);
  if (policy === null) return false;
  const installation = policy["installation"];
  const authentication = policy["authentication"];
  const products = policy["products"];
  return (installation === undefined || (typeof installation === "string"
      && ["NOT_AVAILABLE", "AVAILABLE", "INSTALLED_BY_DEFAULT"].includes(installation)))
    && (authentication === undefined || (typeof authentication === "string"
      && ["ON_INSTALL", "ON_USE"].includes(authentication)))
    && (products === undefined || products === null || (Array.isArray(products)
      && products.every((product) => typeof product === "string"
        && ["chatgpt", "codex", "atlas", "CHATGPT", "CODEX", "ATLAS"].includes(product))));
}

function readCodexMarketplaceManifest(root: string, observations: string[]): CodexMarketplaceManifest | null | false {
  if (!isLocalFilesystemPath(root)) return false;
  for (const segments of CODEX_HOME_MARKETPLACE_MANIFESTS) {
    const observed = readCodexMetadataFile(join(root, ...segments), root, observations);
    if (observed.status === "unsafe") return false;
    if (observed.status === "absent") continue;
    const manifest = decodeCodexMetadataObject(observed.bytes);
    const name = manifest?.["name"];
    const plugins = manifest?.["plugins"];
    if (typeof name !== "string" || !CODEX_ENTRY_NAME.test(name)
      || !Array.isArray(plugins) || plugins.length > MAX_CODEX_ENTRIES) return false;
    const marketplaceInterface = manifest?.["interface"];
    if (marketplaceInterface !== undefined && marketplaceInterface !== null) {
      const details = plainRecord(marketplaceInterface);
      if (details === null || (details["displayName"] !== undefined && details["displayName"] !== null
        && typeof details["displayName"] !== "string")) return false;
    }
    const localSources: Record<string, string | null> = {};
    for (const raw of plugins) {
      const plugin = plainRecord(raw);
      const pluginName = plugin?.["name"];
      if (typeof pluginName !== "string" || !CODEX_ENTRY_NAME.test(pluginName)
        || Object.prototype.hasOwnProperty.call(localSources, pluginName)) return false;
      if (!validCodexMarketplacePolicy(plugin?.["policy"])
        || (plugin?.["category"] !== undefined && plugin["category"] !== null
          && typeof plugin["category"] !== "string")) return false;
      if (name === MARKETPLACE_NAME && pluginName === CODEX_PLUGIN) {
        const policy = plainRecord(plugin?.["policy"]);
        const products = policy?.["products"];
        if (policy?.["installation"] === "NOT_AVAILABLE"
          || (Array.isArray(products)
            && !products.some((product) => typeof product === "string"
              && product.toLowerCase() === "codex"))) return false;
      }
      const source = plainRecord(plugin?.["source"]);
      const rawSource = plugin?.["source"];
      const local = typeof rawSource === "string" ? rawSource
        : source?.["source"] === "local" ? source["path"] : undefined;
      if (local !== undefined) {
        if (typeof local !== "string" || local.length === 0 || hasIdentityControlCharacter(local)) return false;
        const relativeSource = local === "." || local === "./" ? ""
          : local.startsWith("./") ? local.slice(2)
            : segments[0] === ".cursor-plugin" ? local : null;
        if (relativeSource === null || isAbsolute(relativeSource)
          || hasExplicitTraversalSegment(relativeSource)) return false;
        const path = resolve(root, relativeSource);
        if (!isWithin(path, root) || !isLocalFilesystemPath(path)) return false;
        try {
          if (!lstatSync(path).isDirectory()) return false;
        } catch { return false; }
        const traversal = captureRawTraversal(path, false, "directory");
        if (traversal === null) return false;
        observations.push(JSON.stringify({ sourcePath: path, traversal }));
        localSources[pluginName] = path;
      } else if (source?.["source"] === "url" || source?.["source"] === "git-subdir") {
        const url = source["url"];
        const path = source["path"];
        if (typeof url !== "string" || !isCodexGitSource(url)
          || ["ref", "sha"].some((key) => source[key] !== undefined && typeof source[key] !== "string")
          || (source["source"] === "git-subdir" && typeof path !== "string")
          || (path !== undefined && (typeof path !== "string" || path.trim().length === 0
            || isAbsolute(path) || hasIdentityControlCharacter(path)
            || hasExplicitTraversalSegment(path.replace(/^\.\//, ""))))) return false;
        localSources[pluginName] = null;
      } else if (source?.["source"] === "npm") {
        if (typeof source["package"] !== "string"
          || !/^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/.test(source["package"])
          || ["version", "registry"].some((key) => source[key] !== undefined
            && (typeof source[key] !== "string" || source[key].trim().length === 0
              || hasIdentityControlCharacter(source[key])))) return false;
        const registry = source["registry"];
        if (registry !== undefined && (typeof registry !== "string" || !/^https?:\/\/[^\s]+$/.test(registry))) return false;
        localSources[pluginName] = null;
      } else return false;
    }
    return { name, localSources };
  }
  return null;
}

function readCodexHomeMarketplace(
  observations: string[], ownedHome?: string, resolveOsHome: () => string | null = () => {
    try { return homedir(); } catch { return null; }
  },
): {
  entry: Record<string, unknown>; manifest: CodexMarketplaceManifest;
} | null | false {
  const environmentHome = [process.env["HOME"], process.env["USERPROFILE"]]
    .find((value): value is string => typeof value === "string" && value.length > 0 && isAbsolute(value));
  const home = ownedHome ?? (environmentHome !== undefined
    ? environmentHome
    : resolveOsHome());
  if (home === null || !hasLocalFilesystemShape(home)) return false;
  const homeTraversal = captureRawTraversal(home, false, "directory");
  if (homeTraversal === null) return false;
  // Manifest joins normalize the root. Retain every raw HOME/USERPROFILE/OS-home component in
  // both snapshots so a cancelled directory replacement cannot become proven marketplace absence.
  observations.push(JSON.stringify({ homeMarketplaceRoot: home, homeTraversal }));
  const manifest = readCodexMarketplaceManifest(home, observations);
  if (manifest === null || manifest === false) return manifest;
  return {
    entry: { name: manifest.name, root: home, marketplaceSource: { sourceType: "local", source: home } },
    manifest,
  };
}

export interface CodexPluginMetadataBoundaries {
  systemFiles?: readonly string[];
  managedPreferences?: () => "absent" | "present" | "unknown";
  resolveOsHome?: () => string | null;
  windowsQueryFailure?: (reason: CodexWindowsQueryFailureReason) => void;
}

export type CodexWindowsQueryFailureReason =
  | "WINDOWS_QUERY_TEMP_ROOT_UNAVAILABLE"
  | "WINDOWS_QUERY_EXIT_NONZERO"
  | "WINDOWS_QUERY_TIMEOUT"
  | "WINDOWS_QUERY_OUTPUT_LIMIT"
  | "WINDOWS_QUERY_STDERR"
  | "WINDOWS_QUERY_OUTPUT_SHAPE"
  | "WINDOWS_QUERY_TEMP_DRIFT"
  | "WINDOWS_QUERY_PROFILE_DRIFT"
  | "WINDOWS_QUERY_DECODE"
  | "WINDOWS_QUERY_PATH_SHAPE";

const CODEX_MAC_MANAGED_PREFERENCES_SCRIPT = String.raw`
ObjC.import('Foundation');
ObjC.bindFunction('CFPreferencesCopyAppValue', ['id', ['id', 'id']]);
var domain = $(__DOMAIN__);
var keys = ['config_toml_base64', 'requirements_toml_base64'];
keys.some(function(key) { return !$.CFPreferencesCopyAppValue($(key), domain).isNil(); }) ? 'present' : 'absent';
`;

export function readCodexManagedPreferences(domain = "com.openai.codex"): "absent" | "present" | "unknown" {
  if (process.platform !== "darwin") return "absent";
  if (!/^com\.(?:openai\.codex|hoklims\.semctx\.test\.[a-zA-Z0-9-]+)$/.test(domain)) return "unknown";
  // Match Codex's CFPreferencesCopyAppValue lookup, including forced preferences. Only presence
  // is emitted; no policy bytes or credentials are copied into the report.
  const result = runPluginDeliveryQuery(
    ["/usr/bin/osascript", "-l", "JavaScript", "-e",
      CODEX_MAC_MANAGED_PREFERENCES_SCRIPT.replace("__DOMAIN__", JSON.stringify(domain))],
    process.cwd(),
    { timeoutMs: 5000, maxBytes: 1024 },
  );
  if (result.code !== 0 || boundedFailure(result) !== null) return "unknown";
  const status = result.out.trim();
  return status === "absent" || status === "present" ? status : "unknown";
}

const CODEX_WINDOWS_PROGRAM_DATA_SCRIPT = "$ErrorActionPreference = 'Stop'; "
  + "[Console]::Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("
  + "[Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData,"
  + "[Environment+SpecialFolderOption]::None))))";

function codexWindowsQueryTemporaryRoot(protectedRoots: readonly string[]): {
  candidate: string; path: string; traversal: RawTraversalEntry[];
  profileCandidate: string; profilePath: string; profileTraversal: RawTraversalEntry[];
} | null {
  const roots = [...protectedRoots];
  for (const host of PLUGIN_DELIVERY_HOSTS) {
    const home = defaultResolveHostExclusionHome(host);
    if (home === null) return null;
    roots.push(home);
  }
  let profileCandidate = process.env["USERPROFILE"];
  if (profileCandidate === undefined || profileCandidate.length === 0) {
    try { profileCandidate = homedir(); } catch { return null; }
  }
  if (!hasLocalFilesystemShape(profileCandidate)
    || roots.some((root) => isWithinTrustedRoot(profileCandidate, root))) return null;
  const profileTraversal = captureRawTraversal(profileCandidate, false, "directory");
  if (profileTraversal === null || profileTraversal.at(-1)?.exists !== true) return null;
  let profilePath: string;
  try { profilePath = realpathSync.native(resolve(profileCandidate)); } catch { return null; }
  if (roots.some((root) => isWithinTrustedRoot(profilePath, root))) return null;
  const candidates: string[] = [];
  try { candidates.push(tmpdir()); } catch { /* No caller temporary location is usable. */ }
  const windows = process.env["SystemRoot"];
  if (windows !== undefined && hasLocalFilesystemShape(windows)) {
    const separator = windows.endsWith("/") || windows.endsWith("\\") ? "" : sep;
    candidates.push(`${windows}${separator}Temp`);
  }
  for (const candidate of candidates) {
    if (!hasLocalFilesystemShape(candidate) || roots.some((root) => isWithinTrustedRoot(candidate, root))) continue;
    const traversal = captureRawTraversal(candidate, false, "directory");
    if (traversal === null || traversal.at(-1)?.exists !== true) continue;
    try {
      const path = realpathSync.native(resolve(candidate));
      if (roots.some((root) => isWithinTrustedRoot(path, root))) continue;
      return { candidate, path, traversal, profileCandidate, profilePath, profileTraversal };
    } catch { /* An unresolved physical temporary directory cannot host the OS query. */ }
  }
  return null;
}

/** Read the OS known folder, independently of the mutable ProgramData environment variable. */
export function resolveCodexWindowsProgramData(
  protectedRoots: readonly string[] = [process.cwd()],
  onFailure?: (reason: CodexWindowsQueryFailureReason) => void,
): string | null {
  if (process.platform !== "win32") return null;
  const fail = (reason: CodexWindowsQueryFailureReason): null => {
    onFailure?.(reason);
    return null;
  };
  // PowerShell startup can create absent TEMP and USERPROFILE directories even with -NoProfile.
  // Give it only existing physical locations outside the project and protected host trees.
  const temporary = codexWindowsQueryTemporaryRoot(protectedRoots);
  if (temporary === null) return fail("WINDOWS_QUERY_TEMP_ROOT_UNAVAILABLE");
  // The precompiled CLR method calls SHGetFolderPath, a SHGetKnownFolderPath wrapper. None uses
  // flags 0 and verifies existence without creating a directory. An unavailable root stays unknown.
  const result = runPluginDeliveryQuery(
    ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", CODEX_WINDOWS_PROGRAM_DATA_SCRIPT],
    process.cwd(),
    { timeoutMs: PLUGIN_DELIVERY_QUERY_TIMEOUT_MS, maxBytes: 16 * 1024,
      env: { TEMP: temporary.path, TMP: temporary.path, TMPDIR: temporary.path,
        USERPROFILE: temporary.profilePath, HOME: temporary.profilePath } },
  );
  if (result.timedOut === true) return fail("WINDOWS_QUERY_TIMEOUT");
  if (result.truncated === true) return fail("WINDOWS_QUERY_OUTPUT_LIMIT");
  if (result.code !== 0) return fail("WINDOWS_QUERY_EXIT_NONZERO");
  if (result.err.length > 0) return fail("WINDOWS_QUERY_STDERR");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(result.out)) return fail("WINDOWS_QUERY_OUTPUT_SHAPE");
  if (!sameRawTraversal(temporary.candidate, false, "directory", temporary.traversal)) {
    return fail("WINDOWS_QUERY_TEMP_DRIFT");
  }
  if (!sameRawTraversal(temporary.profileCandidate, false, "directory", temporary.profileTraversal)) {
    return fail("WINDOWS_QUERY_PROFILE_DRIFT");
  }
  const bytes = Buffer.from(result.out, "base64");
  if (bytes.toString("base64") !== result.out) return fail("WINDOWS_QUERY_DECODE");
  const path = decodeCodexUtf8(bytes);
  if (path === null) return fail("WINDOWS_QUERY_DECODE");
  const traversal = hasLocalFilesystemShape(path) ? captureRawTraversal(path, false, "directory") : null;
  return traversal !== null && traversal.at(-1)?.exists === true ? path : fail("WINDOWS_QUERY_PATH_SHAPE");
}

function defaultCodexSystemFiles(
  codexHome: string,
  observations: string[],
  repositoryRoot: string,
  windowsQueryFailure?: (reason: CodexWindowsQueryFailureReason) => void,
): string[] | null {
  if (process.platform !== "win32") {
    let systemRoot = "/etc";
    if (process.platform === "darwin") {
      try {
        const stats = lstatSync(systemRoot);
        if (stats.isSymbolicLink()) {
          const target = readlinkSync(systemRoot);
          if ((target !== "private/etc" && target !== "/private/etc")
            || realpathSync.native(systemRoot) !== "/private/etc"
            || !isLocalFilesystemPath("/private/etc")) return null;
          observations.push(JSON.stringify({ systemAlias: "/etc", target, dev: stats.dev, ino: stats.ino }));
          systemRoot = "/private/etc";
        }
      } catch { return null; }
    }
    return ["config.toml", "requirements.toml", "managed_config.toml"].map((name) => join(systemRoot, "codex", name));
  }
  const programData = resolveCodexWindowsProgramData([repositoryRoot, codexHome], windowsQueryFailure);
  if (programData === null) return null;
  const traversal = captureRawTraversal(programData, false, "directory");
  if (traversal === null || traversal.at(-1)?.exists !== true) return null;
  // Retain the raw known-folder lineage even when joining its policy filenames cancels components.
  observations.push(JSON.stringify({ windowsProgramData: programData, traversal }));
  return [
    join(programData, "OpenAI", "Codex", "config.toml"),
    join(programData, "OpenAI", "Codex", "requirements.toml"),
    // 0.147 reads this legacy file; 0.155 warns and ignores it. With an unobserved host version,
    // conservatively refuse a relevant legacy layer rather than assume the latter behavior.
    join(codexHome, "managed_config.toml"),
  ];
}

function codexLayerHasPluginAuthority(observation: OptionalMetadataFile): boolean | null {
  if (observation.status === "unsafe") return null;
  if (observation.status === "absent") return false;
  let layer: Record<string, unknown> | null;
  const text = decodeCodexUtf8(observation.bytes);
  if (text === null) return null;
  try { layer = codexTomlTable(Bun.TOML.parse(text)); } catch { return null; }
  if (layer === null) return null;
  const rawFeatures = layer["features"];
  if (rawFeatures !== undefined) {
    const features = codexTomlTable(rawFeatures);
    if (features === null || (features["plugins"] !== undefined
      && typeof features["plugins"] !== "boolean")) return null;
    if (features["plugins"] !== undefined) return true;
  }
  return ["plugins", "marketplaces", "profile", "profiles", "projects", "project_root_markers"]
    .some((key) => layer[key] !== undefined);
}

function validCodexGitHead(bytes: Buffer): boolean {
  if (bytes.byteLength === 0 || bytes.byteLength > 1024) return false;
  const decoded = decodeCodexUtf8(bytes);
  if (decoded === null) return false;
  const value = decoded.replace(/\n$/, "");
  if (/^[0-9a-f]{40}$/.test(value) || /^[0-9a-f]{64}$/.test(value)) return true;
  if (!value.startsWith("ref: ")) return false;
  const ref = value.slice(5);
  return /^refs\/[a-zA-Z0-9._/-]+$/.test(ref)
    && !ref.includes("..") && !ref.includes("//") && !ref.endsWith("/");
}

function codexGitBoundary(root: string, observations: string[]): string | null {
  let current = root;
  for (let depth = 0; depth < 128; depth += 1) {
    try {
      const gitPath = join(current, ".git");
      const traversal = captureRawTraversal(gitPath, false, "directory");
      if (traversal === null) return null;
      observations.push(JSON.stringify({ gitBoundary: current, traversal }));
      const git = lstatSync(gitPath);
      if (git.isSymbolicLink() || !git.isDirectory()) return null;
      const head = readCodexMetadataFile(join(gitPath, "HEAD"), gitPath, observations);
      if (head.status !== "ok" || !validCodexGitHead(head.bytes)) return null;
      return current;
    } catch (cause) {
      if (cause === null || typeof cause !== "object" || !("code" in cause)
        || (cause as { code?: unknown }).code !== "ENOENT") return null;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

function codexAdditionalLayersAbsent(
  root: string, gitRoot: string, codexHome: string, projects: Record<string, unknown>,
  observations: string[], boundaries: CodexPluginMetadataBoundaries,
): boolean {
  const managed = (boundaries.managedPreferences ?? readCodexManagedPreferences)();
  observations.push(`managed:${managed}`);
  if (managed !== "absent") return false;
  const systemFiles = boundaries.systemFiles ?? defaultCodexSystemFiles(
    codexHome,
    observations,
    root,
    boundaries.windowsQueryFailure,
  );
  if (systemFiles === null) return false;
  for (const file of systemFiles) {
    if (!hasLocalFilesystemShape(file)) return false;
    const observed = readCodexMetadataFile(file, dirname(file), observations);
    const authority = codexLayerHasPluginAuthority(observed);
    if (authority === null || authority) return false;
    if (observed.status === "ok" && file.endsWith("requirements.toml")
      && observed.bytes.toString("utf8").trim().length > 0) return false;
  }
  // Trust is decided per directory. An untrusted child suppresses only that child's layer; it does
  // not hide an effective trusted ancestor layer that Codex still loads.
  const rootTrusted = codexProjectTrusted(projects, root, gitRoot);
  if (rootTrusted === null) return false;
  if (rootTrusted) {
    const cwdLayer = readCodexMetadataFile(join(root, "config.toml"), root, observations);
    if (codexLayerHasPluginAuthority(cwdLayer) !== false) return false;
  }
  let current = root;
  while (current !== gitRoot) {
    current = dirname(current);
    const trusted = codexProjectTrusted(projects, current, gitRoot);
    if (trusted === null) return false;
    if (!trusted) continue;
    const layer = readCodexMetadataFile(join(current, ".codex", "config.toml"), current, observations);
    if (codexLayerHasPluginAuthority(layer) !== false) return false;
  }
  return true;
}

function codexProjectTrusted(projects: Record<string, unknown>, root: string, gitRoot: string): boolean | null {
  const lookupKey = (key: string): string => process.platform === "win32"
    ? key.replace(/[A-Z]/g, (letter) => letter.toLowerCase()) : key;
  for (const candidate of [root, gitRoot]) {
    const candidateKey = lookupKey(candidate);
    const exact = plainRecord(projects[candidateKey])?.["trust_level"];
    if (exact === "trusted" || exact === "untrusted") return exact === "trusted";
    const decisions = Object.entries(projects).flatMap(([declared, raw]) => {
      const decision = plainRecord(raw)?.["trust_level"];
      if (decision !== "trusted" && decision !== "untrusted") return [];
      return lookupKey(declared) === candidateKey ? [{ declared, decision }] : [];
    });
    if (decisions.length === 0) continue;
    decisions.sort((left, right) => left.declared < right.declared ? -1 : left.declared > right.declared ? 1 : 0);
    // Match the pinned loader's deterministic first normalized raw key without resolving declared
    // dot segments into a decision the host never made.
    return decisions[0]?.decision === "trusted";
  }
  return false;
}

interface CodexMetadataSnapshot { inventory: CodexPluginMetadataInventory; observations: string[] }

function readCodexPluginMetadataOnce(
  repositoryRoot: string,
  codexHome: string,
  homeMarketplaceRoot?: string,
  boundaries: CodexPluginMetadataBoundaries = {},
): CodexMetadataSnapshot | null {
  const observations: string[] = [];
  if (!hasLocalFilesystemShape(codexHome)
    || !hasLocalRepositoryRootShape(repositoryRoot)
    || !isLocalFilesystemPath(codexHome)) return null;
  const repositoryTraversal = captureRawTraversal(repositoryRoot, true, "directory");
  const homeTraversal = captureRawTraversal(codexHome, false, "directory");
  if (repositoryTraversal === null || homeTraversal === null) return null;
  observations.push(JSON.stringify({ repositoryRoot, repositoryTraversal, codexHome, homeTraversal }));
  const root = resolve(repositoryRoot);
  if (!isLocalFilesystemPath(root)) return null;
  const gitRoot = codexGitBoundary(root, observations);
  if (gitRoot === null) return null;
  const user = parseCodexConfig(readCodexMetadataFile(join(codexHome, "config.toml"), codexHome, observations));
  if (user === null) return null;
  const userProjects = user["projects"] === undefined ? {} : codexTomlTable(user["projects"]);
  if (userProjects === null || !validCodexProjects(userProjects)) return null;
  const trusted = codexProjectTrusted(userProjects, root, gitRoot);
  if (trusted === null) return null;
  if (!codexAdditionalLayersAbsent(root, gitRoot, codexHome, userProjects, observations, boundaries)) return null;
  // Codex ignores repository config until the user has explicitly trusted that repository.
  const project = trusted
    ? parseCodexConfig(readCodexMetadataFile(join(root, ".codex", "config.toml"), root, observations))
    : {};
  if (project === null) return null;
  const effective = effectiveCodexConfigTables(mergeCodexTomlTables(user, project));
  if (effective === null) return null;
  const marketplaceTables = effective.marketplaces;
  const pluginTables = effective.plugins;
  if (!Object.prototype.hasOwnProperty.call(marketplaceTables, MARKETPLACE_NAME)
    && !codexUnregisteredSelectedSnapshotIsSafe(codexHome, observations)) return null;
  // Native installation targets this cache even when TOML contains no plugin registration.
  // Its physical ancestors and absence therefore belong to both read-only snapshots.
  const semctxCache = readCodexCachedVersion(codexHome, MARKETPLACE_NAME, CODEX_PLUGIN, observations);
  if (semctxCache === false) return null;
  const marketplaces: Record<string, unknown>[] = [];
  const manifests = new Map<string, CodexMarketplaceManifest>();
  const homeMarketplace = readCodexHomeMarketplace(
    observations,
    homeMarketplaceRoot,
    boundaries.resolveOsHome,
  );
  if (homeMarketplace === false) return null;
  if (homeMarketplace !== null) {
    const name = homeMarketplace.manifest.name;
    if (Object.prototype.hasOwnProperty.call(marketplaceTables, name)) return null;
    const configured = plainRecord(homeMarketplace.entry["marketplaceSource"]);
    const expected = codexMarketplaceIdentity(configured?.["sourceType"], configured?.["source"], undefined, []);
    const sidecar = expected === null ? false : readCodexMarketplaceSidecar(expected.source, observations);
    if (expected === null || sidecar === false || (sidecar !== null && !sameCodexMarketplaceIdentity(expected, sidecar))) return null;
    homeMarketplace.entry["sparsePaths"] = expected.sparsePaths;
    marketplaces.push(homeMarketplace.entry);
    manifests.set(name, homeMarketplace.manifest);
  }
  for (const [name, raw] of Object.entries(marketplaceTables)) {
    if (!CODEX_ENTRY_NAME.test(name)) return null;
    const entry = plainRecord(raw);
    const sourceType = entry?.["source_type"];
    const source = entry?.["source"];
    const ref = entry?.["ref"];
    const sparse = entry?.["sparse_paths"];
    const expected = codexMarketplaceIdentity(sourceType, source, ref, sparse === undefined ? [] : sparse);
    if (expected === null
      || (ref !== undefined && typeof ref !== "string")
      || ["last_updated", "last_revision"].some((key) => entry?.[key] !== undefined && typeof entry[key] !== "string")) return null;
    const marketplaceRoot = expected.sourceType === "git"
      ? join(codexHome, ".tmp", "marketplaces", name)
      : codexLocalSourceRoot(expected.source);
    if (marketplaceRoot === null) return null;
    const manifest = readCodexMarketplaceManifest(marketplaceRoot, observations);
    if (manifest === null || manifest === false || manifest.name !== name) return null;
    const sidecar = readCodexMarketplaceSidecar(marketplaceRoot, observations);
    if (sidecar === false || (sidecar !== null && !sameCodexMarketplaceIdentity(expected, sidecar))) return null;
    manifests.set(name, manifest);
    marketplaces.push({
      name,
      root: marketplaceRoot,
      marketplaceSource: { sourceType: expected.sourceType, source: expected.source },
      ...(ref === undefined ? {} : { ref }),
      sparsePaths: expected.sparsePaths,
    });
  }
  const plugins: Record<string, unknown>[] = [];
  for (const [pluginId, raw] of Object.entries(pluginTables)) {
    const separator = pluginId.lastIndexOf("@");
    const plugin = pluginId.slice(0, separator);
    const marketplace = pluginId.slice(separator + 1);
    const entry = plainRecord(raw);
    if (!CODEX_ENTRY_NAME.test(plugin) || !CODEX_ENTRY_NAME.test(marketplace)
      || entry === null || typeof entry["enabled"] !== "boolean"
      || !marketplaces.some((item) => item["name"] === marketplace)) return null;
    const cached = pluginId === CODEX_PLUGIN_ID ? semctxCache
      : readCodexCachedVersion(codexHome, marketplace, plugin, observations);
    if (cached === false) return null;
    const version = cached?.version ?? null;
    const marketplaceEntry = marketplaces.find((item) => item["name"] === marketplace);
    const marketplaceRoot = marketplaceEntry?.["root"];
    const marketplaceSource = plainRecord(marketplaceEntry?.["marketplaceSource"]);
    const sourcePath = manifests.get(marketplace)?.localSources[plugin];
    if (sourcePath === undefined) return null;
    if (pluginId === CODEX_PLUGIN_ID && version !== null
      && isSemctxSource(marketplaceSource?.["source"])) {
      if (!VERSION_SEGMENT.test(version)) return null;
      if (typeof marketplaceRoot !== "string") return null;
      if (sourcePath === null
        || lexicalPathIdentity(sourcePath) !== lexicalPathIdentity(join(marketplaceRoot, "plugins", CODEX_PLUGIN))) return null;
    }
    plugins.push({
      pluginId,
      installed: version !== null,
      enabled: entry["enabled"],
      ...(version === null ? {} : { version }),
      ...(cached === null ? {} : {
        cacheDirectory: cached.directory,
        cachePath: join(codexHome, "plugins", "cache", marketplace, plugin, cached.directory),
      }),
      ...(sourcePath === null ? {} : { source: { path: sourcePath } }),
    });
  }
  if (!Object.prototype.hasOwnProperty.call(pluginTables, CODEX_PLUGIN_ID) && semctxCache !== null) {
    plugins.push({
      pluginId: CODEX_PLUGIN_ID,
      installed: true,
      registered: false,
      version: semctxCache.version,
      cacheDirectory: semctxCache.directory,
      cachePath: join(codexHome, "plugins", "cache", MARKETPLACE_NAME, CODEX_PLUGIN, semctxCache.directory),
    });
  }
  return { inventory: { marketplaces, plugins }, observations };
}

/**
 * Read pinned Codex 0.147/0.155 declarative state without starting the host CLI. The second read
 * refuses visible drift, and every traversed file is bounded and link-free. A truly absent native
 * sidecar is allowed; a present sidecar must match the configured source/ref/sparse identity.
 * No profile is created.
 */
export function readCodexPluginMetadataInventory(
  repositoryRoot: string,
  codexHome: string,
  afterObservation?: () => void,
  homeMarketplaceRoot?: string,
  boundaries: CodexPluginMetadataBoundaries = {},
): CodexPluginMetadataInventory | null {
  const before = readCodexPluginMetadataOnce(repositoryRoot, codexHome, homeMarketplaceRoot, boundaries);
  if (before === null) return null;
  afterObservation?.();
  const after = readCodexPluginMetadataOnce(repositoryRoot, codexHome, homeMarketplaceRoot, boundaries);
  return after !== null && JSON.stringify(before) === JSON.stringify(after) ? after.inventory : null;
}

function lexicalPathIdentity(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function declaredFilesystemIdentity(
  value: unknown,
  observations: RawTraversalObservation[],
): string | null {
  if (
    typeof value !== "string"
    || !hasLocalFilesystemShape(value)
    || !observeRawTraversal(value, false, "directory", observations)
  ) return null;
  return lexicalPathIdentity(value);
}

function enabledPluginsFromSettings(bytes: Buffer | null): Record<string, boolean> | null {
  if (bytes === null) return null;
  const settings = decodeMetadataObject(bytes);
  if (settings === null) return null;
  if (settings["enabledPlugins"] === undefined) return {};
  const enabled = plainRecord(settings["enabledPlugins"]);
  if (enabled === null) return null;
  const result: Record<string, boolean> = {};
  for (const [plugin, value] of Object.entries(enabled)) {
    if (plugin.length === 0 || typeof value !== "boolean") return null;
    result[plugin] = value;
  }
  return result;
}

/**
 * Read Claude Code's pinned declarative plugin metadata without starting Claude Code.
 *
 * Inventory files and settings are confined, bounded, parsed once and re-read before the snapshot
 * is returned. A link-free absent inventory file proves an empty corresponding registry, matching
 * Claude Code 2.1.x on a fresh profile. Malformed, linked, oversized or drifting inventory returns
 * `null`; unavailable settings leave enablement unknown. Project/local entries are considered only
 * for the repository being inspected, so metadata can never direct this reader elsewhere.
 */
export function readClaudePluginMetadataInventory(
  repositoryRoot: string,
  claudeHome: string,
  afterObservation?: () => void,
): ClaudePluginMetadataInventory | null {
  const traversalObservations: RawTraversalObservation[] = [];
  if (!hasLocalFilesystemShape(claudeHome)) return null;
  if (!hasLocalRepositoryRootShape(repositoryRoot)) return null;
  if (!observeRawTraversal(claudeHome, false, "directory", traversalObservations)) return null;
  if (!observeRawTraversal(repositoryRoot, true, "directory", traversalObservations)) return null;
  const absoluteRepositoryRoot = resolve(repositoryRoot);
  if (!isLocalFilesystemPath(absoluteRepositoryRoot)) return null;
  const marketplacesPath = join(claudeHome, "plugins", "known_marketplaces.json");
  const installedPath = join(claudeHome, "plugins", "installed_plugins.json");
  const userSettingsPath = join(claudeHome, "settings.json");
  const marketplacesObservation = readOptionalMetadataFile(marketplacesPath, claudeHome);
  const installedObservation = readOptionalMetadataFile(installedPath, claudeHome);
  const userSettingsObservation = readOptionalMetadataFile(userSettingsPath, claudeHome);
  if (marketplacesObservation.status === "unsafe" || installedObservation.status === "unsafe") {
    return null;
  }
  const marketplacesBytes = marketplacesObservation.status === "ok"
    ? marketplacesObservation.bytes
    : Buffer.from("{}");
  const installedBytes = installedObservation.status === "ok"
    ? installedObservation.bytes
    : Buffer.from('{"version":2,"plugins":{}}');
  const marketplaceRecord = decodeMetadataObject(marketplacesBytes);
  const installedRecord = decodeMetadataObject(installedBytes);
  if (marketplaceRecord === null || installedRecord === null) return null;
  if (installedRecord["version"] !== 2) return null;
  const pluginsRecord = plainRecord(installedRecord["plugins"]);
  if (pluginsRecord === null) return null;

  const marketplaces: Record<string, unknown>[] = [];
  for (const [name, rawEntry] of Object.entries(marketplaceRecord)) {
    const entry = plainRecord(rawEntry);
    const source = plainRecord(entry?.["source"]);
    const sourceKind = source?.["source"];
    const repo = source?.["repo"];
    const url = source?.["url"];
    const path = source?.["path"];
    const ref = source?.["ref"];
    const installLocation = entry?.["installLocation"];
    const lastUpdated = entry?.["lastUpdated"];
    const sourceValue = sourceKind === "github"
      ? repo
      : sourceKind === "git"
        ? url
        : sourceKind === "directory"
          ? path
          : undefined;
    const directoryIdentity = sourceKind === "directory"
      ? declaredFilesystemIdentity(sourceValue, traversalObservations)
      : null;
    const sourceIdentityValid = sourceKind === "directory"
      ? directoryIdentity !== null
      : isValidClaudeSourceIdentity(sourceKind, sourceValue);
    const installLocationIdentity = declaredFilesystemIdentity(installLocation, traversalObservations);
    if (
      name.trim().length === 0
      || entry === null
      || source === null
      || (sourceKind !== "github" && sourceKind !== "git" && sourceKind !== "directory")
      || !sourceIdentityValid
      || installLocationIdentity === null
      || typeof lastUpdated !== "string"
      || (repo !== undefined && typeof repo !== "string")
      || (url !== undefined && typeof url !== "string")
      || (path !== undefined && typeof path !== "string")
      || (ref !== undefined && typeof ref !== "string")
    ) return null;
    marketplaces.push({
      name,
      sourceKind,
      ...(sourceKind === "directory" ? { path: sourceValue } : { repo: sourceValue }),
      ...(typeof ref === "string" ? { ref } : {}),
      installLocation,
    });
  }

  const repositoryIdentity = lexicalPathIdentity(absoluteRepositoryRoot);
  const projectSettingsPath = join(absoluteRepositoryRoot, ".claude", "settings.json");
  const localSettingsPath = join(absoluteRepositoryRoot, ".claude", "settings.local.json");
  const settingsObservations = [
    { path: userSettingsPath, root: claudeHome, observation: userSettingsObservation },
    {
      path: projectSettingsPath,
      root: absoluteRepositoryRoot,
      observation: readOptionalMetadataFile(projectSettingsPath, absoluteRepositoryRoot),
    },
    {
      path: localSettingsPath,
      root: absoluteRepositoryRoot,
      observation: readOptionalMetadataFile(localSettingsPath, absoluteRepositoryRoot),
    },
  ] as const;
  const settingsLayers = settingsObservations.map(({ observation }) =>
    observation.status === "absent"
      ? {}
      : observation.status === "ok"
        ? enabledPluginsFromSettings(observation.bytes)
        : null);
  const settingsReliable = settingsLayers.every(
    (layer): layer is Record<string, boolean> => layer !== null,
  );
  const effectiveEnablement: ClaudePluginMetadataInventory["effectiveEnablement"] = {};
  if (settingsReliable) {
    for (const [index, layer] of settingsLayers.entries()) {
      const scope = (["user", "project", "local"] as const)[index];
      if (scope === undefined) continue;
      for (const [id, enabled] of Object.entries(layer)) {
        effectiveEnablement[id] = { enabled, scope };
      }
    }
  }
  const plugins: Record<string, unknown>[] = [];
  for (const [id, rawEntries] of Object.entries(pluginsRecord)) {
    if (id.trim().length === 0 || !Array.isArray(rawEntries)) return null;
    for (const rawEntry of rawEntries) {
      const entry = plainRecord(rawEntry);
      const scope = entry?.["scope"];
      const installPath = entry?.["installPath"];
      const version = entry?.["version"];
      const projectPath = entry?.["projectPath"];
      const installedAt = entry?.["installedAt"];
      const lastUpdated = entry?.["lastUpdated"];
      const gitCommitSha = entry?.["gitCommitSha"];
      const installIdentity = declaredFilesystemIdentity(installPath, traversalObservations);
      const projectIdentity = projectPath === undefined
        ? null
        : declaredFilesystemIdentity(projectPath, traversalObservations);
      if (
        entry === null
        || (scope !== "user" && scope !== "project" && scope !== "local")
        || installIdentity === null
        || (version !== undefined && typeof version !== "string")
        || (installedAt !== undefined && typeof installedAt !== "string")
        || (lastUpdated !== undefined && typeof lastUpdated !== "string")
        || (gitCommitSha !== undefined && typeof gitCommitSha !== "string")
        || (projectPath !== undefined && projectIdentity === null)
        || ((scope === "project" || scope === "local") && projectIdentity === null)
      ) return null;
      if (scope !== "user" && projectIdentity !== repositoryIdentity) continue;
      const effective = effectiveEnablement[id];
      plugins.push({
        id,
        scope,
        installPath,
        ...(typeof projectPath === "string" ? { projectPath } : {}),
        ...(typeof version === "string" ? { version } : {}),
        ...(effective === undefined ? {} : {
          enabled: effective.enabled,
          enablementScope: effective.scope,
        }),
      });
    }
  }

  // Deterministic test seam for cross-file drift; production never supplies it.
  afterObservation?.();

  if (!traversalObservations.every((observation) =>
    sameRawTraversal(
      observation.candidate,
      observation.allowRelative,
      observation.endpointKind,
      observation.snapshot,
    ))) return null;

  if (!sameOptionalObservation(
    marketplacesObservation,
    readOptionalMetadataFile(marketplacesPath, claudeHome),
  )) return null;
  if (!sameOptionalObservation(
    installedObservation,
    readOptionalMetadataFile(installedPath, claudeHome),
  )) return null;
  for (const { path, root, observation } of settingsObservations) {
    if (!sameOptionalObservation(observation, readOptionalMetadataFile(path, root))) return null;
  }
  return { marketplaces, plugins, settingsValid: settingsReliable, effectiveEnablement };
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
 * Codex records the resolved source, ref, sparse paths and revision in the marketplace root; both hosts also
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
  let codexSidecar: CodexMarketplaceSidecar | null = null;
  const sidecarObservations: string[] = [];
  const sidecar = join(canonicalRoot, ".codex-marketplace-install.json");
  if (host === "codex") {
    const metadata = readCodexMarketplaceSidecar(canonicalRoot, sidecarObservations);
    if (metadata === false) return null;
    codexSidecar = metadata;
    if (metadata !== null) {
      commit = metadata.revision === "" ? null : metadata.revision;
      ref = metadata.ref;
      source = metadata.source;
    }
  } else {
    try {
      const metadata = readConfinedFile(sidecar, canonicalRoot, PLUGIN_DELIVERY_MAX_MANIFEST_BYTES);
      const raw = metadata === null ? undefined : parseJsonValue(metadata.toString("utf8"));
      if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
        const record = raw as Record<string, unknown>;
        commit = safeText(record["revision"]);
        ref = safeText(record["ref_name"]);
        source = safeText(record["source"]);
      }
    } catch {
      // Claude's existing fallback remains independent of Codex metadata refusal.
    }
  }
  if (commit === null && codexSidecar === null) {
    const head = runQuery(["git", "--no-replace-objects", "rev-parse", "HEAD"], canonicalRoot, LOCAL_READ_LIMITS);
    if (head.code === 0) commit = safeText(head.out.trim());
  }
  if (ref === null && codexSidecar === null) {
    const branch = runQuery(
      ["git", "--no-replace-objects", "rev-parse", "--abbrev-ref", "HEAD"],
      canonicalRoot,
      LOCAL_READ_LIMITS,
    );
    if (branch.code === 0) {
      const decoded = branch.bytes === undefined
        ? branch.out
        : branch.bytes === null ? null : decodeCodexUtf8(Buffer.from(branch.bytes));
      const name = decoded === null ? null
        : decoded.endsWith("\r\n") ? decoded.slice(0, -2)
          : decoded.endsWith("\n") ? decoded.slice(0, -1) : decoded;
      ref = name === "HEAD" ? null : name;
    }
  }

  // Each host's snapshot is a full checkout, so both manifests exist in it; read the one that
  // actually governs this host rather than whichever happens to be found first.
  const layout = RELEASE_PLUGIN[host];
  const pluginRoot = canonicalDirectoryWithin(join(canonicalRoot, "plugins", layout.directory), canonicalRoot);
  if (pluginRoot === null) return null;
  const manifest = readPluginManifestIdentity(
    join(pluginRoot, layout.manifest, "plugin.json"), canonicalRoot, host,
  );
  const version = host === "codex" ? manifest.codex?.version ?? null : manifest.version;
  const bundles = bundleDigests(join(pluginRoot, "dist"), canonicalRoot);
  if (host === "codex") {
    const after: string[] = [];
    if (readCodexMarketplaceSidecar(canonicalRoot, after) === false
      || JSON.stringify(sidecarObservations) !== JSON.stringify(after)) return null;
  }
  return { commit, ref, source, version, bundles, pluginIdentity: manifest.codex,
    ...(codexSidecar === null ? {} : { sourceType: codexSidecar.sourceType, sparsePaths: codexSidecar.sparsePaths }) };
}

function readPluginManifestIdentity(
  file: string,
  root: string,
  host: PluginDeliveryHost,
): { codex: CodexPluginManifestIdentity | null; version: string | null } {
  // A manifest is a small JSON document. A file claiming to be one while being far larger is
  // refused by the bounded read rather than parsed.
  const record = host === "codex" ? readCodexMetadataObject(file, root)
    : decodeMetadataObject(readConfinedFile(file, root, PLUGIN_DELIVERY_MAX_MANIFEST_BYTES));
  if (host === "codex") {
    const codex = codexPluginManifestIdentity(record, CODEX_PLUGIN);
    return { codex, version: codex?.version ?? null };
  }
  return { codex: null, version: record === null ? null : safeText(record["version"]) };
}

function defaultReadInstalledPayload(
  host: PluginDeliveryHost,
  path: string,
): InstalledPayloadProbe | null {
  if (!isLocalFilesystemPath(path) || !existsSync(path)) return null;
  const canonicalRoot = canonicalDirectoryWithin(path, path);
  if (canonicalRoot === null) return null;
  const manifest = readPluginManifestIdentity(
    join(canonicalRoot, RELEASE_PLUGIN[host].manifest, "plugin.json"),
    canonicalRoot,
    host,
  );
  const version = host === "codex" ? manifest.codex?.version ?? null : manifest.version;
  if (version === null) return null;
  return {
    pluginIdentity: manifest.codex,
    version,
    bundles: bundleDigests(join(canonicalRoot, "dist"), canonicalRoot),
  };
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

function boundedReleasePayload(outcome: PluginDeliveryQueryOutcome, maxBytes: number): Buffer | null {
  if (outcome.code !== 0 || boundedFailure(outcome) !== null) return null;
  const payload = outcome.bytes ?? new TextEncoder().encode(outcome.out);
  return payload.byteLength <= maxBytes ? Buffer.from(payload) : null;
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

  const manifest = read("apps/cli/package.json");
  const version = codexVersionIdentity(decodeCodexMetadataObject(boundedReleasePayload(manifest,
    PLUGIN_DELIVERY_MAX_MANIFEST_BYTES))?.["version"]);
  if (version === null) return "unreadable";

  const bundles = { codex: {}, claude: {} } as PublicReleaseBundleWitnesses;
  for (const host of PLUGIN_DELIVERY_HOSTS) {
    const layout = RELEASE_PLUGIN[host];
    const pluginManifest = read(`plugins/${layout.directory}/${layout.manifest}/plugin.json`);
    const manifestBytes = boundedReleasePayload(pluginManifest, PLUGIN_DELIVERY_MAX_MANIFEST_BYTES);
    if (manifestBytes === null) return "unreadable";
    const codexIdentity = host === "codex"
      ? codexPluginManifestIdentity(decodeCodexMetadataObject(manifestBytes), CODEX_PLUGIN)
      : null;
    const declared = host === "codex" ? codexIdentity?.version ?? null
      : jsonField(pluginManifest.out, "version");
    if (host === "codex" && declared === null) return "unreadable";
    if (declared !== version) return "diverged";

    const record: Record<string, string | null> = {};
    for (const name of PLUGIN_RUNTIME_BUNDLES) {
      const artifact = read(`plugins/${layout.directory}/dist/${name}`);
      // Raw bytes only. A decoded string would not round-trip to the stored bytes, so a digest
      // taken from it would be a digest of something the release does not contain.
      const payload = boundedReleasePayload(artifact, PLUGIN_DELIVERY_MAX_BUNDLE_BYTES);
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
  if (!hasLocalFilesystemShape(base)) return null;
  if (hasExplicitTraversalSegment(base) && captureRawTraversal(base, false) === null) return null;
  const resolved = resolve(base);
  let canonical: string;
  try {
    canonical = realpathSync.native(resolved);
    if (!hasLocalFilesystemShape(canonical) || !lstatSync(canonical).isDirectory()) return null;
  } catch {
    return null;
  }

  const excluded: string[] = [];
  const exclude = (candidate: string, allowRelative: boolean): boolean => {
    if (allowRelative) {
      if (!hasLocalRepositoryRootShape(candidate)) return false;
      if (!isAbsolute(candidate) && captureRawTraversal(candidate, true, "directory") === null) return false;
    } else if (!hasLocalFilesystemShape(candidate)) {
      return true;
    }
    if (
      isAbsolute(candidate)
      && hasExplicitTraversalSegment(candidate)
      && captureRawTraversal(candidate, false) === null
    ) return false;
    const lexical = resolve(candidate);
    excluded.push(lexical);
    try {
      const actual = realpathSync.native(lexical);
      if (hasLocalFilesystemShape(actual)) excluded.push(actual);
    } catch {
      // A missing exclusion still participates lexically; existing roots also contribute real paths.
    }
    return true;
  };
  if (!exclude(inspectedRoot, true)) return null;
  for (const host of PLUGIN_DELIVERY_HOSTS) {
    const home = resolveHostHome(host);
    // Host homes are resolved read-only; a host that cannot be located simply contributes no
    // exclusion rather than blocking the attestation.
    if (home !== null && !exclude(home, false)) return null;
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
 * This path is informational by construction. It still validates both host manifests and their
 * bundle presence as one coherent release artifact, but discards the computed bundle witnesses:
 * a local mirror has no freshness authority and therefore cannot license delivery convergence.
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
  const artifacts = readReleaseArtifacts(null, repositoryRoot, commit, runQuery, LOCAL_READ_ENVIRONMENT);
  if (artifacts === "unreadable") {
    return unresolvedRelease("absent", "PUBLIC_RELEASE_MANIFEST_UNREADABLE");
  }
  if (artifacts === "diverged") {
    return unresolvedRelease("absent", "PUBLIC_RELEASE_VERSION_DIVERGED");
  }

  return {
    // The mirror proves what was fetched, not that no newer public stable commit exists.
    authority: "local-mirror",
    status: "unknown",
    version: artifacts.version,
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
