import { expect, test } from "bun:test";
import { copyFileSync, cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { createGlobSelectionConfig, type TaskFrame } from "@semantic-context/core";
import { buildClaims, GraphIndex, inspectGraph, prepareContextPack } from "@semantic-context/context-engine";
import { SAMPLE_RUST_REPO } from "@semantic-context/test-fixtures";
import { discoverRepository } from "@semantic-context/ts-analyzer";
import { analyzePlaneARuntime, analyzePlaneARuntimeAsync } from "../src/plane-a-runtime";
import { fingerprintAnalysisInputs } from "../src/freshness";
import { dbPath, initWorkspace } from "@semantic-context/repository-store";
import { checkSemanticState, indexHealth, indexRepository, runChangeImpact, runVerify, verifyAuthoredChange } from "../src";
import { newChangeContract, writeChangeFile } from "@semantic-context/semantic-engine";
import { __setIndexRepositoryCaptureBarrierForTesting } from "../src/indexing";
import { rustMembershipByPath } from "../src/rust-inputs";

test("composes Rust declarations and authored markers with manifest-evidenced crates", async () => {
  const config = {
    ...createGlobSelectionConfig(SAMPLE_RUST_REPO),
    include: ["**/*.rs", "docs/**/*.md"], exclude: ["**/target/**"],
    languages: { rust: "on" as const, markdown: "on" as const },
  };
  const discovery = discoverRepository(config);
  const runtime = analyzePlaneARuntime(config, discovery);
  const confirmation = runtime.analysis.graph.nodes.find((node) => node.name === "confirm" && node.kind === "function");
  expect(confirmation).toMatchObject({ filePath: "domain/src/reservation.rs", exported: true });
  expect(runtime.analysis.graph.edges).toContainEqual(expect.objectContaining({ kind: "constrained_by", from: confirmation?.id, to: "inv:confirmed-never-exceeds-capacity" }));
  expect(runtime.workspaceProjection.nodes.map(({ identity }) => identity).sort()).toEqual(["booking-app", "booking-domain"]);
  expect(runtime.sidecar.discoveryLedger.filter((item) => item.scope.language === "rust").every((item) => item.analysisOutcome === "analyzed")).toBe(true);
  expect(runtime.sidecar.discoveryLedger.filter((item) => item.scope.language === "rust").map((item) => item.scope.dialectVersion)).toEqual(["2024", "2024", "2021", "2021", "2021", "2021"]);
  expect(runtime.analysis.graph.nodes).toContainEqual(expect.objectContaining({ id: "test:app/tests/booking.rs", kind: "test" }));
  expect(runtime.sidecar.capabilityProfiles.filter((profile) => profile.scope.language === "rust").every((profile) => profile.negativeEvidenceEligible === false)).toBe(true);
  const asynchronous = await analyzePlaneARuntimeAsync(config, discovery, 1);
  expect(asynchronous.analysis).toEqual(runtime.analysis);
  expect(asynchronous.sidecar).toEqual(runtime.sidecar);
});

test("ContextPack selects Rust facts from an explicit capability and keeps unsealed provider candidates diagnostic", () => {
  const config = { ...createGlobSelectionConfig(SAMPLE_RUST_REPO), include: ["**/*.rs", "docs/**/*.md"],
    languages: { rust: "on" as const, markdown: "on" as const } };
  const analysis = analyzePlaneARuntime(config, discoverRepository(config)).analysis;
  const frame: TaskFrame = { id: "task:rust-confirmation", rawTask: "Inspect reservation confirmation", mode: "bugfix",
    capabilities: ["reservation-confirmation"], observedBehavior: [], expectedBehavior: [], boundedContexts: [],
    hardInvariants: ["confirmed-never-exceeds-capacity"], softConstraints: [], acceptanceEvidence: [],
    nonGoals: [], riskSurfaces: [], hypotheses: [], createdAt: "2026-10-17T10:00:00.000Z" };
  const inputs = { graph: analysis.graph, evidence: analysis.evidence,
    claims: buildClaims(new GraphIndex(analysis.graph)), taskFrame: frame, now: frame.createdAt, candidateProviders: [] };
  const local = prepareContextPack(inputs);
  expect(local.primaryNodes).toContainEqual(expect.objectContaining({ name: "confirm", filePath: "domain/src/reservation.rs" }));
  expect(local.recommendedReads).toContainEqual(expect.objectContaining({ path: "domain/src/reservation.rs" }));
  const withUnsealed = prepareContextPack({ ...inputs, providerCandidates: [{ provider: "cocoindex",
    filePath: "app/src/main.rs", score: 0.9 }] });
  expect(withUnsealed.meta.warnings).toContain("[PROVIDER_FACT_UNSEALED] Provider candidate cocoindex:app/src/main.rs is diagnostic-only; ignored.");
  expect(withUnsealed.authoritativeClaims).toEqual(local.authoritativeClaims);
  expect(withUnsealed.primaryNodes).toEqual(local.primaryNodes);
});

test("symbol inspection includes a Rust impl declaration", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-rust-impl-inspect-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "bounded"\nversion = "0.1.0"\nedition = "2021"\n');
    writeFileSync(join(root, "src/lib.rs"), "pub struct Booking;\nimpl Booking { pub fn confirm(&self) {} }\n");
    const config = { ...createGlobSelectionConfig(root), include: ["**/*.rs"], languages: { rust: "on" as const } };
    const runtime = analyzePlaneARuntime(config, discoverRepository(config));
    const inspected = inspectGraph({ graph: runtime.analysis.graph, claims: [],
      evidence: runtime.analysis.evidence, query: "impl Booking", kind: "symbol" });
    expect(inspected.matchedNodes).toContainEqual(expect.objectContaining({ kind: "symbol", name: "impl Booking" }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("inserting another valid inherent impl does not readdress existing impl or method identities", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-rust-impl-identity-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "identity"\nversion = "0.1.0"\nedition = "2021"\n');
    const source = join(root, "src/lib.rs");
    const head = "pub struct Item;\n";
    const a = "impl Item { pub fn a(&self) {} }\n";
    const b = "impl Item { pub fn b(&self) {} }\n";
    const config = { ...createGlobSelectionConfig(root), include: ["**/*.rs"], languages: { rust: "on" as const } };
    writeFileSync(source, head + a + b);
    const before = analyzePlaneARuntime(config, discoverRepository(config)).analysis.graph;
    writeFileSync(source, head + "impl Item { pub fn c(&self) {} }\n" + a + b);
    const after = analyzePlaneARuntime(config, discoverRepository(config)).analysis.graph;
    const implId = "sym:symbol:src/lib.rs:impl Item";
    expect(before.nodes.filter((node) => node.name === "impl Item").map((node) => node.id)).toEqual([implId]);
    expect(after.nodes.filter((node) => node.name === "impl Item").map((node) => node.id)).toEqual([implId]);
    for (const method of ["a", "b"]) {
      expect(before.nodes.find((node) => node.name === method)?.id).toBe(`sym:function:src/lib.rs:impl Item.${method}`);
      expect(after.nodes.find((node) => node.name === method)?.id).toBe(`sym:function:src/lib.rs:impl Item.${method}`);
    }
    expect(after.nodes.find((node) => node.id === implId)?.evidence).toHaveLength(3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Rust navigation contributes causal calls and test links without importing test execution evidence", () => {
  const rustAnalyzerPath = process.env.SEMCTX_TEST_RUST_ANALYZER;
  const toolchainRoot = process.env.SEMCTX_TEST_RUST_TOOLCHAIN;
  const target = process.env.SEMCTX_TEST_RUST_TARGET;
  if (rustAnalyzerPath === undefined || toolchainRoot === undefined || target === undefined) throw new Error("Rust integration tooling is required");
  const config = {
    ...createGlobSelectionConfig(SAMPLE_RUST_REPO), include: ["**/*.rs"], exclude: ["**/target/**"], languages: { rust: "on" as const },
    rust: { mode: "navigation" as const, trusted: true as const, rustAnalyzerPath,
      rustAnalyzerSha256: createHash("sha256").update(readFileSync(rustAnalyzerPath)).digest("hex"), toolchainRoot, target, features: [], budgetMs: 30_000 },
  };
  const runtime = analyzePlaneARuntime(config, discoverRepository(config));
  const main = runtime.analysis.graph.nodes.find((node) => node.name === "main");
  const confirm = runtime.analysis.graph.nodes.find((node) => node.name === "confirm" && node.kind === "function");
  expect(runtime.analysis.graph.edges).toContainEqual(expect.objectContaining({ kind: "calls", from: main?.id, to: confirm?.id }));
  expect(runtime.analysis.graph.edges).toContainEqual(expect.objectContaining({ kind: "tested_by", from: confirm?.id, to: "test:domain/tests/confirmation.rs" }));
  expect(runtime.sidecar.capabilityProfiles.filter((profile) => profile.scope.language === "rust" && profile.factKind === "calls").map((profile) => profile.resolutionSemantics)).toContain("rust-navigation-test-v1");
  expect(runtime.sidecar.capabilityProfiles.every((profile) => !profile.negativeEvidenceEligible)).toBe(true);
}, 40_000);

test("Rust navigation keeps trait dispatch and conditional imports or calls outside concrete edges", () => {
  const rustAnalyzerPath = process.env.SEMCTX_TEST_RUST_ANALYZER;
  const toolchainRoot = process.env.SEMCTX_TEST_RUST_TOOLCHAIN;
  const target = process.env.SEMCTX_TEST_RUST_TARGET;
  if (rustAnalyzerPath === undefined || toolchainRoot === undefined || target === undefined) throw new Error("Rust integration tooling is required");
  const root = mkdtempSync(join(tmpdir(), "semctx-rust-conditional-navigation-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "conditional"\nversion = "0.1.0"\nedition = "2021"\n');
    writeFileSync(join(root, "src/lib.rs"), [
      "pub trait Speak { fn say(&self); }",
      "pub struct Voice;",
      "impl Speak for Voice { fn say(&self) {} }",
      "pub fn run<T: Speak>(item: &T) { item.say(); }",
      "mod inner { pub fn value() {} }",
      '#[cfg(target_os = "windows")] use inner::value;',
      "pub fn target() {}",
      'pub fn conditional() { #[cfg(target_os = "windows")] target(); }',
      "",
    ].join("\n"));
    const config = { ...createGlobSelectionConfig(root), include: ["**/*.rs"], languages: { rust: "on" as const },
      rust: { mode: "navigation" as const, trusted: true as const, rustAnalyzerPath,
        rustAnalyzerSha256: createHash("sha256").update(readFileSync(rustAnalyzerPath)).digest("hex"),
        toolchainRoot, target, features: [], budgetMs: 30_000 } };
    const runtime = analyzePlaneARuntime(config, discoverRepository(config));
    const run = runtime.analysis.graph.nodes.find((node) => node.name === "run");
    const conditional = runtime.analysis.graph.nodes.find((node) => node.name === "conditional");
    const traitMethod = runtime.analysis.graph.nodes.find((node) => node.name === "say" && node.metadata.scope === "trait Speak");
    const targetNode = runtime.analysis.graph.nodes.find((node) => node.name === "target");
    const value = runtime.analysis.graph.nodes.find((node) => node.name === "value");
    expect(runtime.analysis.graph.edges.some((edge) => edge.kind === "calls" && edge.from === run?.id && edge.to === traitMethod?.id)).toBe(false);
    expect(runtime.analysis.graph.edges.some((edge) => edge.kind === "calls" && edge.from === conditional?.id && edge.to === targetNode?.id)).toBe(false);
    expect(runtime.analysis.graph.edges.some((edge) => edge.kind === "references" && edge.to === value?.id)).toBe(false);
    expect(runtime.sidecar.discoveryLedger.find((item) => item.scope.selectedPaths.includes("src/lib.rs"))?.analysisReasons)
      .toContain("RUST_TRAIT_DISPATCH_UNRESOLVED:4");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 40_000);

test("Rust navigation never resolves a production caller into the cfg(test) world", () => {
  const rustAnalyzerPath = process.env.SEMCTX_TEST_RUST_ANALYZER;
  const toolchainRoot = process.env.SEMCTX_TEST_RUST_TOOLCHAIN;
  const target = process.env.SEMCTX_TEST_RUST_TARGET;
  if (rustAnalyzerPath === undefined || toolchainRoot === undefined || target === undefined) throw new Error("Rust integration tooling is required");
  const root = mkdtempSync(join(tmpdir(), "semctx-rust-test-world-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "world"\nversion = "0.1.0"\nedition = "2021"\n');
    writeFileSync(join(root, "src/lib.rs"), "#[cfg(test)] mod tests { pub fn helper() {} }\npub fn run() { tests::helper(); }\n");
    const config = { ...createGlobSelectionConfig(root), include: ["**/*.rs"], languages: { rust: "on" as const },
      rust: { mode: "navigation" as const, trusted: true as const, rustAnalyzerPath,
        rustAnalyzerSha256: createHash("sha256").update(readFileSync(rustAnalyzerPath)).digest("hex"),
        toolchainRoot, target, features: [], budgetMs: 30_000 } };
    const runtime = analyzePlaneARuntime(config, discoverRepository(config));
    const run = runtime.analysis.graph.nodes.find((node) => node.name === "run");
    const helper = runtime.analysis.graph.nodes.find((node) => node.name === "helper");
    expect(helper).toMatchObject({ metadata: expect.objectContaining({ testContext: true }) });
    expect(runtime.analysis.graph.edges.some((edge) => edge.from === run?.id && edge.to === helper?.id
      && (edge.kind === "calls" || edge.kind === "references"))).toBe(false);
    expect(runtime.sidecar.discoveryLedger.find((item) => item.scope.selectedPaths.includes("src/lib.rs"))?.analysisReasons)
      .toContain("RUST_TEST_WORLD_TARGET_UNAVAILABLE:2");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 40_000);

test("a top-level cfg(test) use does not become a production import or reference", () => {
  const rustAnalyzerPath = process.env.SEMCTX_TEST_RUST_ANALYZER;
  const toolchainRoot = process.env.SEMCTX_TEST_RUST_TOOLCHAIN;
  const target = process.env.SEMCTX_TEST_RUST_TARGET;
  if (rustAnalyzerPath === undefined || toolchainRoot === undefined || target === undefined) throw new Error("Rust integration tooling is required");
  const root = mkdtempSync(join(tmpdir(), "semctx-rust-test-use-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "test_use"\nversion = "0.1.0"\nedition = "2021"\n');
    writeFileSync(join(root, "src/lib.rs"), "pub mod target;\n#[cfg(test)] use crate::target::helper;\npub fn run() { #[cfg(test)] target::helper(); }\n#[cfg(test)] mod tests { use crate::target::helper; #[test] fn check() { helper(); } }\n");
    writeFileSync(join(root, "src/target.rs"), "pub fn helper() {}\n");
    const config = { ...createGlobSelectionConfig(root), include: ["**/*.rs"], languages: { rust: "on" as const },
      rust: { mode: "navigation" as const, trusted: true as const, rustAnalyzerPath,
        rustAnalyzerSha256: createHash("sha256").update(readFileSync(rustAnalyzerPath)).digest("hex"),
        toolchainRoot, target, features: [], budgetMs: 30_000 } };
    const runtime = analyzePlaneARuntime(config, discoverRepository(config));
    const helper = runtime.analysis.graph.nodes.find((node) => node.name === "helper");
    const run = runtime.analysis.graph.nodes.find((node) => node.name === "run");
    expect(runtime.analysis.graph.edges.some((edge) => edge.kind === "calls" && edge.from === run?.id
      && edge.to === helper?.id)).toBe(false);
    expect(runtime.analysis.graph.edges.some((edge) => edge.kind === "references" && edge.from === "mod:src/lib.rs"
      && edge.to === helper?.id)).toBe(false);
    expect(runtime.analysis.graph.edges.find((edge) => edge.kind === "imports" && edge.from === "mod:src/lib.rs"
      && edge.to === "mod:src/target.rs")?.evidence.map((evidence) => evidence.startLine)).toEqual([1]);
    expect(runtime.analysis.graph.edges).toContainEqual(expect.objectContaining({ kind: "references", from: "test:src/lib.rs", to: helper?.id,
      evidence: expect.arrayContaining([expect.objectContaining({ sourceKind: "test", startLine: 4 })]) }));
    expect(runtime.analysis.graph.edges).toContainEqual(expect.objectContaining({ kind: "imports", from: "test:src/lib.rs", to: "mod:src/target.rs",
      evidence: expect.arrayContaining([expect.objectContaining({ sourceKind: "test", startLine: 4 })]) }));
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 40_000);

test("an integration target cannot claim coverage of a library-only cfg(test) function", () => {
  const rustAnalyzerPath = process.env.SEMCTX_TEST_RUST_ANALYZER;
  const toolchainRoot = process.env.SEMCTX_TEST_RUST_TOOLCHAIN;
  const target = process.env.SEMCTX_TEST_RUST_TARGET;
  if (rustAnalyzerPath === undefined || toolchainRoot === undefined || target === undefined) throw new Error("Rust integration tooling is required");
  const root = mkdtempSync(join(tmpdir(), "semctx-rust-integration-world-"));
  try {
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "tests"));
    writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "world"\nversion = "0.1.0"\nedition = "2021"\n');
    writeFileSync(join(root, "src/lib.rs"), "#[cfg(test)] pub fn helper() {}\n");
    writeFileSync(join(root, "tests/integration.rs"), "#[test] fn check() { world::helper(); }\n");
    const config = { ...createGlobSelectionConfig(root), include: ["**/*.rs"], languages: { rust: "on" as const },
      rust: { mode: "navigation" as const, trusted: true as const, rustAnalyzerPath,
        rustAnalyzerSha256: createHash("sha256").update(readFileSync(rustAnalyzerPath)).digest("hex"),
        toolchainRoot, target, features: [], budgetMs: 30_000 } };
    const runtime = analyzePlaneARuntime(config, discoverRepository(config));
    const helper = runtime.analysis.graph.nodes.find((node) => node.name === "helper");
    const checking = runtime.analysis.graph.nodes.find((node) => node.name === "check");
    expect(runtime.analysis.graph.edges.some((edge) => edge.from === checking?.id && edge.to === helper?.id
      && (edge.kind === "calls" || edge.kind === "references"))).toBe(false);
    expect(runtime.analysis.graph.edges.some((edge) => edge.from === helper?.id && edge.kind === "tested_by")).toBe(false);
    expect(runtime.sidecar.discoveryLedger.find((item) => item.scope.selectedPaths.includes("tests/integration.rs"))?.analysisReasons)
      .toContain("RUST_TEST_WORLD_TARGET_UNAVAILABLE:1");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 40_000);

test("binds Cargo metadata even when source selection only includes Rust files", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-rust-inputs-"));
  try {
    cpSync(SAMPLE_RUST_REPO, root, { recursive: true });
    const config = { ...createGlobSelectionConfig(root), include: ["**/*.rs"], languages: { rust: "on" as const } };
    const files = discoverRepository(config).files;
    const baseline = fingerprintAnalysisInputs(config, files);
    expect(fingerprintAnalysisInputs(config, files.map((file) => ({ ...file, content: file.content.replaceAll("\n", "\r\n") })))).not.toBe(baseline);
    const manifest = join(root, "domain/Cargo.toml");
    const original = readFileSync(manifest, "utf8");
    writeFileSync(manifest, original.replace("2021", "2024"));
    expect(fingerprintAnalysisInputs(config, files)).not.toBe(baseline);
    writeFileSync(manifest, original);
    expect(fingerprintAnalysisInputs(config, files)).toBe(baseline);
    mkdirSync(join(root, ".cargo"));
    writeFileSync(join(root, ".cargo/config.toml"), '[build]\ntarget = "aarch64-apple-darwin"\n');
    expect(fingerprintAnalysisInputs(config, files)).not.toBe(baseline);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("invalidates Rust navigation input binding when pinned toolchain bytes change or disappear", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-rust-toolchain-binding-"));
  try {
    const toolchainRoot = join(root, "toolchain");
    const analyzer = join(root, "rust-analyzer");
    const executable = process.platform === "win32" ? ".exe" : "";
    mkdirSync(join(toolchainRoot, "bin"), { recursive: true });
    mkdirSync(join(toolchainRoot, "lib/rustlib/src/rust/library"), { recursive: true });
    mkdirSync(join(toolchainRoot, "lib/rustlib/aarch64-apple-darwin/lib"), { recursive: true });
    writeFileSync(analyzer, "analyzer-v1");
    writeFileSync(join(toolchainRoot, "bin", `rustc${executable}`), "compiler-v1");
    writeFileSync(join(toolchainRoot, "bin", `cargo${executable}`), "cargo-v1");
    writeFileSync(join(toolchainRoot, "lib/rustlib/src/rust/library/lib.rs"), "source-v1");
    writeFileSync(join(toolchainRoot, "lib/rustlib/aarch64-apple-darwin/lib/libstd.rlib"), "stdlib-v1");
    const initialized = Bun.spawnSync(["git", "init", "-q"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    expect(initialized.exitCode).toBe(0);
    const config = { ...createGlobSelectionConfig(root), languages: { rust: "on" as const },
      rust: { mode: "navigation" as const, trusted: true as const, rustAnalyzerPath: analyzer,
        rustAnalyzerSha256: createHash("sha256").update("analyzer-v1").digest("hex"),
        toolchainRoot, target: "aarch64-apple-darwin", features: [], budgetMs: 30_000 } };
    const baseline = fingerprintAnalysisInputs(config, []);
    const qualified = { ...config, selectionMode: "qualified-static-v1" as const, analysisProfile: "public-monorepo-static-v1" as const };
    const qualifiedBaseline = fingerprintAnalysisInputs(qualified, []);
    writeFileSync(join(toolchainRoot, "bin", `rustc${executable}`), "compiler-v2");
    expect(fingerprintAnalysisInputs(config, [])).not.toBe(baseline);
    expect(fingerprintAnalysisInputs(qualified, [])).not.toBe(qualifiedBaseline);
    writeFileSync(join(toolchainRoot, "bin", `rustc${executable}`), "compiler-v1");
    expect(fingerprintAnalysisInputs(config, [])).toBe(baseline);
    expect(fingerprintAnalysisInputs(qualified, [])).toBe(qualifiedBaseline);
    rmSync(join(toolchainRoot, "lib/rustlib/src/rust/library/lib.rs"));
    expect(fingerprintAnalysisInputs(config, [])).not.toBe(baseline);
    expect(fingerprintAnalysisInputs(qualified, [])).not.toBe(qualifiedBaseline);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("persisted Rust facts are admitted only while source and Cargo inputs remain fresh", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-rust-lifecycle-"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  };
  try {
    cpSync(SAMPLE_RUST_REPO, root, { recursive: true });
    writeFileSync(join(root, ".gitignore"), ".semctx/\ntarget/\n");
    git("init", "-q"); git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    initWorkspace(root, { ...createGlobSelectionConfig(root), include: ["**/*.rs", "docs/**/*.md"], exclude: ["**/target/**"],
      languages: { rust: "on", markdown: "on" } });
    indexRepository(root, "2026-10-17T10:00:00.000Z");
    const fresh = indexHealth(root);
    expect(fresh).toMatchObject({ binding: { status: "valid" }, freshness: { verdict: "FRESH" } });
    const rustDecisions = fresh.evaluations.decisions.filter((decision) => decision.candidateIdentity.startsWith("rust:"));
    expect(rustDecisions.some((decision) => decision.factKind === "function" && decision.gates.taskRelativeAuthority === "passed")).toBe(true);
    expect(rustDecisions.some((decision) => decision.factKind === "imports" && decision.gates.capabilityMatch === "passed")).toBe(true);
    expect(rustDecisions.every((decision) => decision.gates.negativeCompleteness !== "passed")).toBe(true);
    expect(fresh.coverage.status).toBe("partial");
    const manifest = join(root, "domain/Cargo.toml");
    const original = readFileSync(manifest, "utf8");
    writeFileSync(manifest, original.replace("2021", "2024"));
    expect(indexHealth(root).freshness.verdict).toBe("STALE");
    writeFileSync(manifest, original);
    expect(indexHealth(root).freshness.verdict).toBe("FRESH");
    const source = join(root, "domain/src/reservation.rs");
    const originalSource = readFileSync(source, "utf8");
    writeFileSync(source, `${originalSource}\n`);
    indexRepository(root, "2026-10-17T10:01:00.000Z");
    const benign = runVerify(root, { kind: "working-tree" }).report;
    expect(benign.verdict).toBe("WARN");
    writeFileSync(source, originalSource);
    indexRepository(root, "2026-10-17T10:02:00.000Z");
    writeFileSync(source, originalSource.replace("> 0", ">= 0"));
    expect(indexHealth(root).freshness.verdict).toBe("STALE");
    const impact = runChangeImpact(root, { kind: "working-tree" });
    expect(impact.analysis.binding.status).toBe("bound");
    expect(impact.changes.files.find((file) => file.path === "domain/src/reservation.rs")?.coverage).toMatchObject({ status: "not_analyzed", language: "rust", reason: "ANALYSIS_PARTIAL" });
    expect(impact.changes.units?.some((unit) => unit.id === "sym:function:domain/src/reservation.rs:confirm")).toBe(true);
    expect(impact.unresolved?.some((item) => item.code === "RUST_ANALYSIS_PARTIAL" && item.file === "domain/src/reservation.rs")).toBe(true);
    expect(impact.explicitlyUnaffected).toEqual([]);
    const verification = runVerify(root, { kind: "working-tree" }).report;
    expect(verification.verdict).toBe("BLOCK");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Rust authored anchors resolve and report deleted, renamed and ambiguous declarations", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-rust-authored-links-"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  };
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "anchors"\nversion = "0.1.0"\nedition = "2021"\n');
    const sourcePath = join(root, "src/lib.rs");
    writeFileSync(sourcePath, "pub fn confirm() {}\n");
    writeFileSync(join(root, ".gitignore"), ".semctx/\ntarget/\n");
    git("init", "-q"); git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    initWorkspace(root, { ...createGlobSelectionConfig(root), include: ["**/*.rs"], languages: { rust: "on" } });
    writeChangeFile(root, newChangeContract({ id: "change.rust-anchor", statement: "Keep confirmation reachable",
      lifecycle: "verified", links: ["sym:function:src/lib.rs:confirm"] }));
    indexRepository(root, "2026-10-17T10:00:00.000Z");
    expect(checkSemanticState(root).staleLinks).toEqual([]);
    expect(verifyAuthoredChange(root, "change.rust-anchor", { kind: "working-tree" }).stale).toEqual([]);
    writeFileSync(sourcePath, "pub fn renamed() {}\n");
    indexRepository(root, "2026-10-17T10:01:00.000Z");
    expect(checkSemanticState(root).staleLinks).toContainEqual(expect.objectContaining({
      ownerId: "change.rust-anchor", reasonCode: "symbol_gone",
      link: { kind: "symbol", ref: "sym:function:src/lib.rs:confirm" },
    }));
    expect(verifyAuthoredChange(root, "change.rust-anchor", { kind: "working-tree" })).toMatchObject({
      verdict: "STALE", stale: [expect.objectContaining({ kind: "stale_link" })],
    });
    writeFileSync(sourcePath, "pub fn confirm() {}\npub fn confirm() {}\n");
    indexRepository(root, "2026-10-17T10:02:00.000Z");
    expect(checkSemanticState(root).staleLinks).toContainEqual(expect.objectContaining({
      ownerId: "change.rust-anchor", reasonCode: "ambiguous",
      candidates: ["sym:function:src/lib.rs:confirm#1", "sym:function:src/lib.rs:confirm#2"],
    }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Rust SQLite and Git lifecycle binds cold, edit, add, delete, rename, checkout and worktree states", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-rust-git-lifecycle-"));
  const sibling = mkdtempSync(join(tmpdir(), "semctx-rust-linked-worktree-"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  };
  const commit = (message: string) => {
    git("add", "-A");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", message);
  };
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "lifecycle"\nversion = "0.1.0"\nedition = "2021"\n');
    writeFileSync(join(root, "src/lib.rs"), "pub mod detail;\npub fn stable() -> u32 { detail::value() }\n");
    writeFileSync(join(root, "src/detail.rs"), "pub fn value() -> u32 { 1 }\n");
    writeFileSync(join(root, ".gitignore"), ".semctx/\ntarget/\n");
    git("init", "-q"); commit("baseline");
    const baseline = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root, stdout: "pipe" }).stdout.toString().trim();
    const config = { ...createGlobSelectionConfig(root), include: ["**/*.rs"], languages: { rust: "on" as const } };
    initWorkspace(root, config);
    expect(indexHealth(root).binding.status).toBe("absent");
    const cold = indexRepository(root, "2026-10-17T10:00:00.000Z");
    expect(cold.analysis.graph.nodes.some((node) => node.name === "value")).toBe(true);
    expect(indexHealth(root)).toMatchObject({ binding: { status: "valid" }, freshness: { verdict: "FRESH" } });
    expect(indexRepository(root, "2026-10-17T10:01:00.000Z").analysis.graph).toEqual(cold.analysis.graph);

    writeFileSync(join(root, "src/detail.rs"), "pub fn value() -> u32 { 2 }\n");
    expect(indexHealth(root).freshness.verdict).toBe("STALE");
    indexRepository(root, "2026-10-17T10:02:00.000Z");
    expect(indexHealth(root).freshness.verdict).toBe("DIRTY_KNOWN");

    writeFileSync(join(root, "src/lib.rs"), "pub mod detail;\npub mod added;\npub fn stable() -> u32 { detail::value() }\n");
    writeFileSync(join(root, "src/added.rs"), "pub fn added() -> u32 { 3 }\n");
    expect(indexHealth(root).freshness.verdict).toBe("STALE");
    const added = indexRepository(root, "2026-10-17T10:03:00.000Z");
    expect(added.analysis.graph.nodes).toContainEqual(expect.objectContaining({ id: "sym:function:src/added.rs:added" }));
    commit("add source");

    writeFileSync(join(root, "src/lib.rs"), "pub mod added;\npub fn stable() -> u32 { added::added() }\n");
    rmSync(join(root, "src/detail.rs"));
    const deleted = indexRepository(root, "2026-10-17T10:04:00.000Z");
    expect(deleted.analysis.graph.nodes.some((node) => node.filePath === "src/detail.rs")).toBe(false);
    commit("delete source");

    git("mv", "src/added.rs", "src/renamed.rs");
    writeFileSync(join(root, "src/lib.rs"), "pub mod renamed;\npub fn stable() -> u32 { renamed::added() }\n");
    const renamed = indexRepository(root, "2026-10-17T10:05:00.000Z");
    expect(renamed.analysis.graph.nodes).toContainEqual(expect.objectContaining({ id: "sym:function:src/renamed.rs:added" }));
    expect(renamed.analysis.graph.nodes.some((node) => node.filePath === "src/added.rs")).toBe(false);
    commit("rename source");
    git("checkout", "-q", baseline);
    expect(indexHealth(root).freshness.verdict).toBe("STALE");
    const restored = indexRepository(root, "2026-10-17T10:06:00.000Z");
    expect(restored.analysis.graph.nodes.some((node) => node.filePath === "src/detail.rs")).toBe(true);
    expect(restored.analysis.graph.nodes.some((node) => node.filePath === "src/renamed.rs")).toBe(false);

    git("worktree", "add", "-q", "--detach", sibling, baseline);
    initWorkspace(sibling, { ...createGlobSelectionConfig(sibling), include: ["**/*.rs"], languages: { rust: "on" } });
    const linked = indexRepository(sibling, "2026-10-17T10:07:00.000Z");
    expect(linked.analysis.graph.nodes.some((node) => node.filePath === "src/detail.rs" && node.name === "value")).toBe(true);
    expect(indexHealth(sibling)).toMatchObject({ binding: { status: "valid" }, freshness: { verdict: "FRESH" } });
  } finally {
    try { git("worktree", "remove", "--force", sibling); } catch { rmSync(sibling, { recursive: true, force: true }); }
    rmSync(root, { recursive: true, force: true });
  }
});

test("index-health keeps Rust analyzed, unsupported, failed and disabled outcomes distinct", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-rust-health-outcomes-"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  };
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "health"\nversion = "0.1.0"\nedition = "2021"\n');
    writeFileSync(join(root, "src/lib.rs"), "pub mod broken;\npub fn healthy() {}\n");
    writeFileSync(join(root, "src/broken.rs"), "pub fn broken( {\n");
    writeFileSync(join(root, "src/orphan.rs"), "pub fn orphan() {}\n");
    writeFileSync(join(root, ".gitignore"), ".semctx/\ntarget/\n");
    git("init", "-q"); git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    const config = { ...createGlobSelectionConfig(root), include: ["**/*.rs"], languages: { rust: "on" as const } };
    initWorkspace(root, config);
    indexRepository(root, "2026-10-17T10:00:00.000Z");
    const health = indexHealth(root);
    const outcomes = new Map(health.candidates.filter((candidate) => candidate.language === "rust")
      .map((candidate) => [candidate.path, candidate]));
    expect(outcomes.get("src/lib.rs")?.analysisOutcome).toBe("analyzed");
    expect(outcomes.get("src/orphan.rs")?.analysisOutcome).toBe("unsupported");
    expect(outcomes.get("src/broken.rs")?.analysisOutcome).toBe("failed");
    expect(outcomes.get("src/broken.rs")?.analysisReasons).toContain("rust:parse-error:1");
    expect(health.coverage.status).toBe("insufficient");
    initWorkspace(root, { ...config, languages: { rust: "off" } });
    indexRepository(root, "2026-10-17T10:01:00.000Z");
    const disabled = indexHealth(root);
    expect(disabled.candidates.filter((candidate) => candidate.language === "rust")
      .map((candidate) => candidate.analysisOutcome)).toEqual(["disabled", "disabled", "disabled"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const scenario of [
  { name: "benign", replace: (source: string) => `${source}\n`, verdict: "WARN" },
  { name: "contract break", replace: (source: string) => source.replace("        Confirmation::Full", "        Confirmation::Accepted"), verdict: "BLOCK" },
  { name: "invariant violation", replace: (source: string) => source.replace("> 0", ">= 0"), verdict: "BLOCK" },
] as const) {
  test(`Rust fixture ${scenario.name} yields ${scenario.verdict} after reindexing`, () => {
    const root = mkdtempSync(join(tmpdir(), "semctx-rust-verify-scenario-"));
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    };
    try {
      cpSync(SAMPLE_RUST_REPO, root, { recursive: true });
      writeFileSync(join(root, ".gitignore"), ".semctx/\ntarget/\n");
      git("init", "-q"); git("add", ".");
      git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
      initWorkspace(root, { ...createGlobSelectionConfig(root), include: ["**/*.rs", "docs/**/*.md"],
        languages: { rust: "on", markdown: "on" } });
      const sourcePath = join(root, "domain/src/reservation.rs");
      writeFileSync(sourcePath, scenario.replace(readFileSync(sourcePath, "utf8")));
      indexRepository(root, "2026-10-17T10:00:00.000Z");
      const report = runVerify(root, { kind: "working-tree" }).report;
      expect(report.changedFiles).toContain("domain/src/reservation.rs");
      expect(report.verdict).toBe(scenario.verdict);
      if (scenario.name !== "benign") {
        expect(report.changedSymbols).toContainEqual(expect.objectContaining({ name: "confirm", file: "domain/src/reservation.rs" }));
        expect(report.impactedInvariants.some((item) => item.statement.includes("confirmed seats never exceed total capacity"))).toBe(true);
        expect(report.impactedContracts.some((item) => item.statement.includes("a full venue refuses confirmation"))).toBe(true);
        expect(report.findings).toContainEqual(expect.objectContaining({ rule: "invariant_touched_without_test", tier: "strict", severity: "block" }));
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("Rust exported type change exercises the configured advisory contract rule", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-rust-advisory-contract-"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  };
  try {
    cpSync(SAMPLE_RUST_REPO, root, { recursive: true });
    writeFileSync(join(root, ".gitignore"), ".semctx/\ntarget/\n");
    git("init", "-q"); git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    const baseConfig = createGlobSelectionConfig(root);
    initWorkspace(root, { ...baseConfig, include: ["**/*.rs", "docs/**/*.md"],
      languages: { rust: "on", markdown: "on" },
      blockingRules: baseConfig.blockingRules.filter((rule) => rule.when === "contract_changed_without_test") });
    const sourcePath = join(root, "domain/src/capacity.rs");
    writeFileSync(sourcePath, readFileSync(sourcePath, "utf8").replace("pub total: u32", "pub(crate) total: u32"));
    indexRepository(root, "2026-10-17T10:00:00.000Z");
    const report = runVerify(root, { kind: "working-tree" }).report;
    expect(report.changedSymbols).toContainEqual(expect.objectContaining({ name: "Capacity", kind: "type", file: "domain/src/capacity.rs" }));
    expect(report.findings).toContainEqual(expect.objectContaining({ rule: "contract_changed_without_test", tier: "advisory", severity: "warn" }));
    expect(report.verdict).toBe("WARN");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("resolved Rust test links recommend a relevant test without reporting its execution", () => {
  const rustAnalyzerPath = process.env.SEMCTX_TEST_RUST_ANALYZER;
  const toolchainRoot = process.env.SEMCTX_TEST_RUST_TOOLCHAIN;
  const target = process.env.SEMCTX_TEST_RUST_TARGET;
  if (rustAnalyzerPath === undefined || toolchainRoot === undefined || target === undefined) throw new Error("Rust integration tooling is required");
  const root = mkdtempSync(join(tmpdir(), "semctx-rust-test-recommendation-"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  };
  try {
    cpSync(SAMPLE_RUST_REPO, root, { recursive: true });
    writeFileSync(join(root, ".gitignore"), ".semctx/\ntarget/\n");
    git("init", "-q"); git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    initWorkspace(root, { ...createGlobSelectionConfig(root), include: ["**/*.rs", "docs/**/*.md"],
      languages: { rust: "on", markdown: "on" },
      rust: { mode: "navigation", trusted: true, rustAnalyzerPath,
        rustAnalyzerSha256: createHash("sha256").update(readFileSync(rustAnalyzerPath)).digest("hex"),
        toolchainRoot, target, features: [], budgetMs: 30_000 } });
    const sourcePath = join(root, "domain/src/reservation.rs");
    writeFileSync(sourcePath, readFileSync(sourcePath, "utf8").replace("> 0", ">= 0"));
    indexRepository(root, "2026-10-17T10:00:00.000Z");
    const report = runVerify(root, { kind: "working-tree" }).report;
    expect(report.recommendedTests).toContainEqual(expect.objectContaining({ file: "domain/tests/confirmation.rs" }));
    expect(report.verdict).not.toBe("PASS");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 45_000);

test("persisted Rust navigation becomes stale when its pinned analyzer changes", () => {
  const rustAnalyzerPath = process.env.SEMCTX_TEST_RUST_ANALYZER;
  const toolchainRoot = process.env.SEMCTX_TEST_RUST_TOOLCHAIN;
  const target = process.env.SEMCTX_TEST_RUST_TARGET;
  if (rustAnalyzerPath === undefined || toolchainRoot === undefined || target === undefined) throw new Error("Rust integration tooling is required");
  const root = mkdtempSync(join(tmpdir(), "semctx-rust-analyzer-snapshot-"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  };
  try {
    cpSync(SAMPLE_RUST_REPO, root, { recursive: true });
    writeFileSync(join(root, ".gitignore"), ".semctx/\ntarget/\n");
    git("init", "-q"); git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    mkdirSync(join(root, ".semctx"));
    const analyzerCopy = join(root, ".semctx", "pinned-rust-analyzer");
    copyFileSync(rustAnalyzerPath, analyzerCopy);
    const original = readFileSync(analyzerCopy);
    initWorkspace(root, { ...createGlobSelectionConfig(root), include: ["**/*.rs"], languages: { rust: "on" },
      rust: { mode: "navigation", trusted: true, rustAnalyzerPath: analyzerCopy,
        rustAnalyzerSha256: createHash("sha256").update(original).digest("hex"), toolchainRoot, target, features: [], budgetMs: 30_000 } });
    indexRepository(root, "2026-10-17T10:00:00.000Z");
    expect(indexHealth(root)).toMatchObject({ binding: { status: "valid" }, freshness: { verdict: "FRESH" } });
    writeFileSync(analyzerCopy, Buffer.concat([original, Buffer.from("drift")]));
    expect(indexHealth(root)).toMatchObject({ freshness: { verdict: "STALE" } });
    writeFileSync(analyzerCopy, original);
    expect(indexHealth(root)).toMatchObject({ binding: { status: "valid" }, freshness: { verdict: "FRESH" } });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 40_000);

test("Cargo drift during Rust analysis preserves the preceding SQLite snapshot", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-rust-capture-drift-"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  };
  try {
    cpSync(SAMPLE_RUST_REPO, root, { recursive: true });
    writeFileSync(join(root, ".gitignore"), ".semctx/\ntarget/\n");
    git("init", "-q"); git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    initWorkspace(root, { ...createGlobSelectionConfig(root), include: ["**/*.rs"], languages: { rust: "on" } });
    indexRepository(root, "2026-10-17T10:00:00.000Z");
    const prior = readFileSync(dbPath(root));
    const manifest = join(root, "domain/Cargo.toml");
    const original = readFileSync(manifest, "utf8");
    git("update-index", "--assume-unchanged", "domain/Cargo.toml");
    __setIndexRepositoryCaptureBarrierForTesting(() => writeFileSync(manifest, original.replace("2021", "2024")));
    expect(() => indexRepository(root, "2026-10-17T10:01:00.000Z")).toThrow("repository inputs changed while the index was being built");
    expect(readFileSync(dbPath(root))).toEqual(prior);
  } finally {
    __setIndexRepositoryCaptureBarrierForTesting(undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not admit a Rust file that no Cargo target or module owns", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-rust-orphan-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "bounded"\nversion = "0.1.0"\nedition = "2021"\n');
    writeFileSync(join(root, "src/lib.rs"), "pub mod linked;\n");
    writeFileSync(join(root, "src/linked.rs"), "pub fn linked() {}\n");
    writeFileSync(join(root, "src/orphan.rs"), "pub fn orphan() {}\n");
    const config = { ...createGlobSelectionConfig(root), include: ["**/*.rs"], languages: { rust: "on" as const } };
    const runtime = analyzePlaneARuntime(config, discoverRepository(config));
    const byPath = new Map(runtime.sidecar.discoveryLedger.filter((item) => item.scope.language === "rust")
      .map((item) => [item.scope.selectedPaths[0], item]));
    expect(byPath.get("src/lib.rs")?.scope.dialectVersion).toBe("2021");
    expect(byPath.get("src/linked.rs")?.scope.dialectVersion).toBe("2021");
    expect(byPath.get("src/orphan.rs")?.analysisOutcome).toBe("unsupported");
    expect(runtime.analysis.graph.nodes.some((node) => node.filePath === "src/orphan.rs")).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("does not admit the conventional library root replaced by an explicit Cargo path", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-rust-lib-path-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "bounded"\nversion = "0.1.0"\nedition = "2021"\n[lib]\npath = "src/real.rs"\n');
    writeFileSync(join(root, "src/lib.rs"), "pub fn ghost() {}\n");
    writeFileSync(join(root, "src/real.rs"), "pub fn actual() {}\n");
    const config = { ...createGlobSelectionConfig(root), include: ["**/*.rs"], languages: { rust: "on" as const } };
    const runtime = analyzePlaneARuntime(config, discoverRepository(config));
    expect(runtime.analysis.graph.nodes.some((node) => node.name === "actual")).toBe(true);
    expect(runtime.analysis.graph.nodes.some((node) => node.name === "ghost")).toBe(false);
    expect(runtime.sidecar.discoveryLedger.find((item) => item.scope.selectedPaths.includes("src/lib.rs"))?.analysisOutcome).toBe("unsupported");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("does not turn an absolute Cargo target path into a nested crate member", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-rust-absolute-target-"));
  try {
    mkdirSync(join(root, "crate"));
    writeFileSync(join(root, "crate/Cargo.toml"), '[package]\nname = "bounded"\nversion = "0.1.0"\nedition = "2021"\n[lib]\npath = "/absolute.rs"\n');
    writeFileSync(join(root, "crate/absolute.rs"), "pub fn ghost() {}\n");
    const config = { ...createGlobSelectionConfig(root), include: ["**/*.rs"], languages: { rust: "on" as const } };
    const runtime = analyzePlaneARuntime(config, discoverRepository(config));
    expect(runtime.analysis.graph.nodes.some((node) => node.name === "ghost")).toBe(false);
    expect(runtime.sidecar.discoveryLedger.find((item) => item.scope.selectedPaths.includes("crate/absolute.rs"))?.analysisOutcome).toBe("unsupported");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Cargo target membership refuses absolute, drive and backslash path spellings", () => {
  for (const path of ["/outside.rs", "C:/outside.rs", "\\\\server\\share.rs"]) {
    const candidate = `crate/${path}`;
    const membership = rustMembershipByPath([{ path: "crate/Cargo.toml",
      content: `[package]\nname = "bounded"\nversion = "0.1.0"\nedition = "2021"\n[lib]\npath = '${path}'\n` }],
    [candidate], []);
    expect(membership.editionsByPath.has(candidate)).toBe(false);
  }
});

test("Cargo convention admits directory-form binary, test, example and bench targets", () => {
  const paths = ["src/bin/tool/main.rs", "tests/booking/main.rs", "examples/demo/main.rs", "benches/perf/main.rs"];
  const membership = rustMembershipByPath([{ path: "Cargo.toml",
    content: '[package]\nname = "bounded"\nversion = "0.1.0"\nedition = "2021"\n' }], paths, []);
  expect([...membership.editionsByPath.keys()].sort()).toEqual([...paths].sort());
  expect([...membership.testPaths]).toEqual(["tests/booking/main.rs"]);
});

test("a Rust file shared by Cargo targets or manifests has no single analysis world", () => {
  const sharedTarget = rustMembershipByPath([{ path: "Cargo.toml",
    content: '[package]\nname = "bounded"\nversion = "0.1.0"\nedition = "2021"\n[lib]\npath = "src/shared.rs"\n[[bin]]\nname = "runner"\npath = "src/shared.rs"\n' }],
  ["src/shared.rs"], []);
  expect(sharedTarget.ambiguousPaths.has("src/shared.rs")).toBe(true);

  const sharedManifest = rustMembershipByPath([
    { path: "Cargo.toml", content: '[package]\nname = "outer"\nversion = "0.1.0"\nedition = "2018"\n[lib]\npath = "inner/src/lib.rs"\n' },
    { path: "inner/Cargo.toml", content: '[package]\nname = "inner"\nversion = "0.1.0"\nedition = "2024"\n' },
  ], ["inner/src/lib.rs"], []);
  expect(sharedManifest.ambiguousPaths.has("inner/src/lib.rs")).toBe(true);
});

test("an explicit Cargo target matching its conventional target remains one world", () => {
  const membership = rustMembershipByPath([{ path: "Cargo.toml",
    content: '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n[[bin]]\nname = "app"\npath = "src/main.rs"\n' }],
  ["src/main.rs"], []);
  expect(membership.editionsByPath.get("src/main.rs")).toBe("2021");
  expect(membership.ambiguousPaths.has("src/main.rs")).toBe(false);
});

test("an explicit Cargo target can rename a conventional target without adding a world", () => {
  const membership = rustMembershipByPath([{ path: "Cargo.toml",
    content: '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n[[bin]]\nname = "renamed"\npath = "src/main.rs"\n[[test]]\nname = "also_renamed"\npath = "tests/booking.rs"\n' }],
  ["src/main.rs", "tests/booking.rs"], []);
  expect([...membership.editionsByPath.keys()].sort()).toEqual(["src/main.rs", "tests/booking.rs"]);
  expect(membership.testPaths.has("tests/booking.rs")).toBe(true);
  expect([...membership.ambiguousPaths]).toEqual([]);
});

test("a module reached from distinct Cargo targets has no single analysis world", () => {
  const content = "mod shared;\n";
  const modules = ["src/lib.rs", "src/main.rs"].map((relPath) => ({ relPath, name: "shared", rustKind: "mod_item",
    scope: [], attributes: [], range: { startOffset: 0, endOffset: 11, startLine: 1, endLine: 1 } }));
  const membership = rustMembershipByPath([
    { path: "Cargo.toml", content: '[package]\nname = "bounded"\nversion = "0.1.0"\nedition = "2021"\n' },
    ...modules.map(({ relPath }) => ({ path: relPath, content })),
  ], ["src/lib.rs", "src/main.rs", "src/shared.rs"], modules);
  expect(membership.editionsByPath.has("src/shared.rs")).toBe(true);
  expect(membership.ambiguousPaths.has("src/shared.rs")).toBe(true);
});

test("a declared Cargo workspace member inherits its edition and version", () => {
  const member = { path: "crate/Cargo.toml",
    content: '[package]\nname = "member"\nversion.workspace = true\nedition.workspace = true\n' };
  const workspace = { path: "Cargo.toml",
    content: '[workspace]\nmembers = ["crate"]\n[workspace.package]\nversion = "0.1.0"\nedition = "2021"\n' };
  const paths = ["crate/src/lib.rs"];
  const admitted = rustMembershipByPath([workspace, member], paths, []);
  expect(admitted.editionsByPath.get(paths[0]!)).toBe("2021");
  const unlisted = rustMembershipByPath([{ ...workspace, content: workspace.content.replace('"crate"', '"other"') }, member], paths, []);
  expect(unlisted.editionsByPath.has(paths[0]!)).toBe(false);
});

test("an explicit Cargo test target outside tests directories retains test-only evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-rust-explicit-test-target-"));
  try {
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "spec"));
    writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "bounded"\nversion = "0.1.0"\nedition = "2021"\nautotests = false\n[[test]]\nname = "booking"\npath = "spec/booking.rs"\n');
    writeFileSync(join(root, "src/lib.rs"), "pub fn value() {}\n");
    writeFileSync(join(root, "spec/booking.rs"), "#[test] fn booking() { bounded::value(); }\n");
    const config = { ...createGlobSelectionConfig(root), include: ["**/*.rs"], languages: { rust: "on" as const } };
    const runtime = analyzePlaneARuntime(config, discoverRepository(config));
    expect(runtime.analysis.graph.nodes).toContainEqual(expect.objectContaining({ id: "test:spec/booking.rs", kind: "test" }));
    expect(runtime.analysis.graph.nodes.some((node) => node.id === "mod:spec/booking.rs")).toBe(false);
    expect(runtime.analysis.graph.nodes.find((node) => node.name === "booking")?.evidence)
      .toContainEqual(expect.objectContaining({ sourceKind: "test" }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a source file shared by Cargo lib and test targets is refused instead of losing production exports", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-rust-dual-target-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "bounded"\nversion = "0.1.0"\nedition = "2021"\n[[test]]\nname = "shared"\npath = "src/lib.rs"\n');
    writeFileSync(join(root, "src/lib.rs"), "pub fn exported() {}\n");
    const config = { ...createGlobSelectionConfig(root), include: ["**/*.rs"], languages: { rust: "on" as const } };
    const runtime = analyzePlaneARuntime(config, discoverRepository(config));
    expect(runtime.sidecar.discoveryLedger.find((item) => item.scope.selectedPaths.includes("src/lib.rs")))
      .toMatchObject({ analysisOutcome: "unsupported", analysisReasons: expect.arrayContaining(["RUST_TARGET_WORLD_AMBIGUOUS"]) });
    expect(runtime.analysis.graph.nodes.some((node) => node.filePath === "src/lib.rs")).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("does not admit automatically discovered targets disabled by Cargo", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-rust-auto-targets-"));
  try {
    mkdirSync(join(root, "src/bin"), { recursive: true });
    writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "bounded"\nversion = "0.1.0"\nedition = "2021"\nautobins = false\n[[bin]]\nname = "real"\npath = "src/real.rs"\n');
    writeFileSync(join(root, "src/main.rs"), "fn ghost_main() {}\n");
    writeFileSync(join(root, "src/bin/ghost.rs"), "fn ghost_bin() {}\n");
    writeFileSync(join(root, "src/real.rs"), "fn real() {}\n");
    const config = { ...createGlobSelectionConfig(root), include: ["**/*.rs"], languages: { rust: "on" as const } };
    const runtime = analyzePlaneARuntime(config, discoverRepository(config));
    expect(runtime.analysis.graph.nodes.some((node) => node.name === "real")).toBe(true);
    expect(runtime.analysis.graph.nodes.some((node) => node.name === "ghost_main" || node.name === "ghost_bin")).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("invalid Cargo automatic target flags do not confer structural authority", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-rust-invalid-auto-target-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "bounded"\nversion = "0.1.0"\nedition = "2021"\nautobins = "false"\n');
    writeFileSync(join(root, "src/main.rs"), "pub fn ghost() {}\n");
    const config = { ...createGlobSelectionConfig(root), include: ["**/*.rs"], languages: { rust: "on" as const } };
    const runtime = analyzePlaneARuntime(config, discoverRepository(config));
    expect(runtime.analysis.graph.nodes.some((node) => node.name === "ghost")).toBe(false);
    expect(runtime.sidecar.discoveryLedger.find((item) => item.scope.selectedPaths.includes("src/main.rs"))?.analysisOutcome).toBe("unsupported");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("does not invent default module membership when a Rust path attribute redirects it", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-rust-path-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "bounded"\nversion = "0.1.0"\nedition = "2021"\n');
    writeFileSync(join(root, "src/lib.rs"), '#[path = "other.rs"]\npub mod linked;\n');
    writeFileSync(join(root, "src/linked.rs"), "pub fn false_member() {}\n");
    writeFileSync(join(root, "src/other.rs"), "pub fn actual_member() {}\n");
    const config = { ...createGlobSelectionConfig(root), include: ["**/*.rs"], languages: { rust: "on" as const } };
    const runtime = analyzePlaneARuntime(config, discoverRepository(config));
    expect(runtime.analysis.graph.nodes.some((node) => node.name === "false_member")).toBe(false);
    expect(runtime.sidecar.discoveryLedger.find((item) => item.scope.selectedPaths.includes("src/linked.rs"))?.analysisOutcome).toBe("unsupported");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("uses canonical LF Rust source identity while retaining raw evidence offsets", () => {
  const config = { ...createGlobSelectionConfig(SAMPLE_RUST_REPO), include: ["**/*.rs"], languages: { rust: "on" as const } };
  const discovery = discoverRepository(config);
  const lf = analyzePlaneARuntime(config, discovery);
  const crlf = analyzePlaneARuntime(config, { ...discovery, files: discovery.files.map((file) => ({ ...file, content: file.content.replaceAll("\n", "\r\n") })) });
  expect(crlf.sidecar.scope.sourceStateDigest).toBe(lf.sidecar.scope.sourceStateDigest);
  expect(crlf.sidecar.discoveryLedger.map((item) => item.scope.sourceStateDigest)).toEqual(lf.sidecar.discoveryLedger.map((item) => item.scope.sourceStateDigest));
  expect(crlf.analysis.graph.nodes.find((node) => node.name === "confirm")?.metadata.startByte).not.toBe(lf.analysis.graph.nodes.find((node) => node.name === "confirm")?.metadata.startByte);
});

test("does not publish inactive conditional declarations as ordinary Rust facts", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-rust-cfg-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "bounded"\nversion = "0.1.0"\nedition = "2021"\n');
    writeFileSync(join(root, "src/lib.rs"), '#[cfg(target_os = "windows")]\npub fn windows_only() {}\npub fn always() {}\n');
    const config = { ...createGlobSelectionConfig(root), include: ["**/*.rs"], languages: { rust: "on" as const } };
    const runtime = analyzePlaneARuntime(config, discoverRepository(config));
    expect(runtime.analysis.graph.nodes.some((node) => node.name === "windows_only")).toBe(false);
    expect(runtime.analysis.graph.nodes.some((node) => node.name === "always")).toBe(true);
    expect(runtime.sidecar.discoveryLedger.find((item) => item.scope.selectedPaths.includes("src/lib.rs"))?.analysisReasons).toContain("rust:conditional-source:1");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("keeps inline cfg(test) declarations in the test evidence world", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-rust-inline-test-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "bounded"\nversion = "0.1.0"\nedition = "2021"\n');
    writeFileSync(join(root, "src/lib.rs"), '#[cfg(test)]\nmod tests { pub fn helper() {} }\n');
    const config = { ...createGlobSelectionConfig(root), include: ["**/*.rs"], languages: { rust: "on" as const } };
    const runtime = analyzePlaneARuntime(config, discoverRepository(config));
    const helper = runtime.analysis.graph.nodes.find((node) => node.name === "helper");
    expect(helper).toMatchObject({ exported: false, evidence: [expect.objectContaining({ sourceKind: "test" })] });
    expect(runtime.analysis.graph.edges).toContainEqual(expect.objectContaining({ kind: "declares", from: "test:src/lib.rs", to: helper?.id }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("anchors Rust claim evidence to its explicit documentation attribute", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-rust-marker-evidence-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "bounded"\nversion = "0.1.0"\nedition = "2021"\n');
    writeFileSync(join(root, "src/lib.rs"), '#[doc = "@invariant positive: stays positive"]\npub fn value() -> u32 { 1 }\n');
    const config = { ...createGlobSelectionConfig(root), include: ["**/*.rs"], languages: { rust: "on" as const } };
    const runtime = analyzePlaneARuntime(config, discoverRepository(config));
    const invariant = runtime.analysis.graph.nodes.find((node) => node.id === "inv:positive");
    expect(invariant?.evidence).toContainEqual(expect.objectContaining({ filePath: "src/lib.rs", startLine: 1,
      excerpt: '#[doc = "@invariant positive: stays positive"]' }));
    const relation = runtime.analysis.graph.edges.find((edge) => edge.kind === "constrained_by" && edge.to === "inv:positive");
    expect(relation?.evidence).toContainEqual(expect.objectContaining({ startLine: 1 }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Rust marker and authored documents expose contradictions without deriving a contract from pub", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-rust-claims-"));
  try {
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "claims"\nversion = "0.1.0"\nedition = "2021"\n');
    writeFileSync(join(root, "src/lib.rs"), '#[doc = "@invariant bounded: The value never exceeds the limit"]\npub fn value() -> u32 { 1 }\npub fn plain() {}\n');
    writeFileSync(join(root, "src/other.py"), "# @invariant bounded: The value may exceed the limit\ndef other():\n    return 2\n");
    writeFileSync(join(root, "docs/a.md"), "---\ninvariants: [bounded]\ncontradicts: [docs/b.md]\n---\n# Claim A\n");
    writeFileSync(join(root, "docs/b.md"), "# Claim B\n");
    const config = { ...createGlobSelectionConfig(root), include: ["**/*.{rs,py,md}"],
      languages: { rust: "on" as const, python: "on" as const, markdown: "on" as const } };
    const runtime = analyzePlaneARuntime(config, discoverRepository(config));
    const invariant = runtime.analysis.graph.nodes.find((node) => node.id === "inv:bounded");
    expect(invariant?.tags).toContain("statement-divergent");
    expect(invariant?.metadata.statement).toBeUndefined();
    expect(runtime.analysis.graph.edges).toContainEqual(expect.objectContaining({
      kind: "constrained_by", from: "sym:function:src/lib.rs:value", to: "inv:bounded",
    }));
    expect(runtime.analysis.graph.edges).toContainEqual(expect.objectContaining({
      kind: "contradicts", from: "doc:docs/a.md", to: "doc:docs/b.md",
    }));
    expect(runtime.analysis.graph.nodes.some((node) => node.kind === "contract" && node.filePath === "src/lib.rs")).toBe(false);
    expect(buildClaims(new GraphIndex(runtime.analysis.graph)).find((claim) => claim.kind === "invariant" && claim.subjectNodeIds.includes("inv:bounded"))?.verificationStatus).toBe("contradicted");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("composes Rust beside TypeScript, JavaScript, Python and Markdown in one workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-rust-mixed-"));
  try {
    cpSync(SAMPLE_RUST_REPO, root, { recursive: true });
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/price.ts"), "export function price(): number { return 3; }\n");
    writeFileSync(join(root, "src/quote.mjs"), "export function quote() { return 3; }\n");
    writeFileSync(join(root, "src/stock.py"), "def stock():\n    return 3\n");
    const config = { ...createGlobSelectionConfig(root), include: ["**/*.{rs,ts,mjs,py,md}"], exclude: ["**/target/**"],
      languages: { rust: "on" as const, typescript: "on" as const, javascript: "on" as const,
        python: "on" as const, markdown: "on" as const } };
    const runtime = analyzePlaneARuntime(config, discoverRepository(config));
    for (const name of ["confirm", "price", "quote", "stock"]) {
      expect(runtime.analysis.graph.nodes.some((node) => node.name === name)).toBe(true);
    }
    expect(runtime.sidecar.discoveryLedger.filter((item) => ["rust", "typescript", "javascript", "python", "markdown"].includes(item.scope.language))
      .every((item) => item.analysisOutcome === "analyzed")).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("resolved Rust calls appear in impact without a negative non-impact claim", () => {
  const rustAnalyzerPath = process.env.SEMCTX_TEST_RUST_ANALYZER;
  const toolchainRoot = process.env.SEMCTX_TEST_RUST_TOOLCHAIN;
  const target = process.env.SEMCTX_TEST_RUST_TARGET;
  if (rustAnalyzerPath === undefined || toolchainRoot === undefined || target === undefined) throw new Error("Rust integration tooling is required");
  const root = mkdtempSync(join(tmpdir(), "semctx-rust-impact-"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  };
  try {
    cpSync(SAMPLE_RUST_REPO, root, { recursive: true });
    writeFileSync(join(root, ".gitignore"), ".semctx/\ntarget/\n");
    git("init", "-q"); git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    git("branch", "baseline");
    const config = { ...createGlobSelectionConfig(root), include: ["**/*.rs"], languages: { rust: "on" as const },
      rust: { mode: "navigation" as const, trusted: true as const, rustAnalyzerPath,
        rustAnalyzerSha256: createHash("sha256").update(readFileSync(rustAnalyzerPath)).digest("hex"),
        toolchainRoot, target, features: [], budgetMs: 30_000 } };
    initWorkspace(root, config);
    indexRepository(root, "2026-10-17T10:00:00.000Z");
    const source = join(root, "domain/src/reservation.rs");
    writeFileSync(source, readFileSync(source, "utf8").replace("> 0", ">= 0"));
    const report = runChangeImpact(root, { kind: "working-tree" });
    expect(report.analysis.binding.status).toBe("bound");
    expect(report.changes.files.find((file) => file.path === "domain/src/reservation.rs")?.coverage?.status).toBe("analyzed");
    expect(report.changes.units?.some((unit) => unit.id === "sym:function:domain/src/reservation.rs:confirm")).toBe(true);
    expect(report.directlyAffected?.some((item) => item.id === "sym:function:app/src/main.rs:main")).toBe(true);
    expect(report.explicitlyUnaffected).toEqual([]);
    git("add", "domain/src/reservation.rs");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "changed confirmation");
    indexRepository(root, "2026-10-17T10:01:00.000Z");
    const range = runChangeImpact(root, { kind: "range", base: "baseline" });
    expect(range.analysis.binding).toMatchObject({ status: "bound", rangeSide: "new" });
    expect(range.changes.units?.some((unit) => unit.id === "sym:function:domain/src/reservation.rs:confirm" && unit.side === "new")).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 45_000);

test("Rust impact preserves direct and transitive call distances", () => {
  const rustAnalyzerPath = process.env.SEMCTX_TEST_RUST_ANALYZER;
  const toolchainRoot = process.env.SEMCTX_TEST_RUST_TOOLCHAIN;
  const target = process.env.SEMCTX_TEST_RUST_TARGET;
  if (rustAnalyzerPath === undefined || toolchainRoot === undefined || target === undefined) throw new Error("Rust integration tooling is required");
  const root = mkdtempSync(join(tmpdir(), "semctx-rust-impact-chain-"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  };
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "Cargo.toml"), '[package]\nname="chain"\nversion="0.1.0"\nedition="2021"\n');
    const source = "pub fn leaf() -> u32 { 1 }\npub fn middle() -> u32 { leaf() }\npub fn entry() -> u32 { middle() }\n";
    writeFileSync(join(root, "src/lib.rs"), source);
    writeFileSync(join(root, ".gitignore"), ".semctx/\ntarget/\n");
    git("init", "-q"); git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    initWorkspace(root, { ...createGlobSelectionConfig(root), include: ["**/*.rs"], languages: { rust: "on" },
      rust: { mode: "navigation", trusted: true, rustAnalyzerPath,
        rustAnalyzerSha256: createHash("sha256").update(readFileSync(rustAnalyzerPath)).digest("hex"),
        toolchainRoot, target, features: [], budgetMs: 30_000 } });
    writeFileSync(join(root, "src/lib.rs"), source.replace("{ 1 }", "{ 2 }"));
    indexRepository(root, "2026-10-17T10:00:00.000Z");
    const report = runChangeImpact(root, { kind: "working-tree" });
    expect(report.analysis.binding.status).toBe("bound");
    expect(report.changes.units).toContainEqual(expect.objectContaining({ id: "sym:function:src/lib.rs:leaf" }));
    expect(report.directlyAffected).toContainEqual(expect.objectContaining({ id: "sym:function:src/lib.rs:middle", distance: 1 }));
    expect(report.transitivelyAffected).toContainEqual(expect.objectContaining({ id: "sym:function:src/lib.rs:entry", distance: 2 }));
    expect(report.directlyAffected?.find((item) => item.name === "middle")?.via).toHaveLength(1);
    expect(report.transitivelyAffected?.find((item) => item.name === "entry")?.via).toHaveLength(2);
    expect(report.explicitlyUnaffected).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 45_000);

test("Rust impact classifies a declaration added on the new diff side", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-rust-added-outline-"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  };
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "outline"\nversion = "0.1.0"\nedition = "2021"\n');
    const source = join(root, "src/lib.rs");
    writeFileSync(source, "pub fn existing() {}\n");
    writeFileSync(join(root, ".gitignore"), ".semctx/\ntarget/\n");
    git("init", "-q"); git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    initWorkspace(root, { ...createGlobSelectionConfig(root), include: ["**/*.rs"], languages: { rust: "on" } });
    indexRepository(root, "2026-10-17T10:00:00.000Z");
    writeFileSync(source, "pub fn existing() {}\npub fn added() {}\n");
    const impact = runChangeImpact(root, { kind: "working-tree" });
    expect(impact.analysis.binding.status).toBe("bound");
    expect(impact.changes.units, JSON.stringify({ changes: impact.changes, unresolved: impact.unresolved })).toContainEqual(expect.objectContaining({
      kind: "added_declaration", file: "src/lib.rs", side: "new", names: ["added"],
    }));
    expect(impact.explicitlyUnaffected).toEqual([]);
    writeFileSync(source, "pub fn existing() {}\n#[cfg(test)] pub fn test_only() {}\n");
    const testWorldImpact = runChangeImpact(root, { kind: "working-tree" });
    expect(testWorldImpact.changes.units?.find((unit) => unit.names.includes("test_only"))?.exported).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Rust impact keeps a public inherent method visible to a module importer", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-rust-method-impact-"));
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  };
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "method"\nversion = "0.1.0"\nedition = "2021"\n');
    writeFileSync(join(root, "src/lib.rs"), "pub mod booking;\n");
    const source = join(root, "src/booking.rs");
    writeFileSync(source, "pub struct Booking;\nimpl Booking { pub fn confirm(&self) -> u32 { 1 } }\n");
    writeFileSync(join(root, ".gitignore"), ".semctx/\ntarget/\n");
    git("init", "-q"); git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    initWorkspace(root, { ...createGlobSelectionConfig(root), include: ["**/*.rs"], languages: { rust: "on" } });
    indexRepository(root, "2026-10-17T10:00:00.000Z");
    writeFileSync(source, "pub struct Booking;\nimpl Booking { pub fn confirm(&self) -> u32 { 2 } }\n");
    const impact = runChangeImpact(root, { kind: "working-tree" });
    expect(impact.changes.units).toContainEqual(expect.objectContaining({
      id: "sym:function:src/booking.rs:impl Booking.confirm", exported: true,
    }));
    expect(impact.possiblyAffected).toContainEqual(expect.objectContaining({ id: "mod:src/lib.rs" }));
    expect(impact.explicitlyUnaffected).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function structuralRustFixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "semctx-rust-scope-"));
  try {
    const entries = { "Cargo.toml": '[package]\nname = "bounded"\nversion = "0.1.0"\nedition = "2021"\n', ...files };
    for (const [path, content] of Object.entries(entries)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    const config = { ...createGlobSelectionConfig(root), include: ["**/*.rs"], languages: { rust: "on" as const } };
    return analyzePlaneARuntime(config, discoverRepository(config));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("does not treat nested src/tests files as automatic Cargo test targets", () => {
  const runtime = structuralRustFixture({ "src/lib.rs": "pub fn root() {}\n", "src/tests/orphan.rs": "#[test] fn phantom_test() {}\n" });
  expect(runtime.sidecar.discoveryLedger.find((item) => item.scope.selectedPaths.includes("src/tests/orphan.rs"))?.analysisOutcome).toBe("unsupported");
  expect(runtime.analysis.graph.nodes.some((node) => node.filePath === "src/tests/orphan.rs")).toBe(false);
});

test("follows an external module declared inside an inline Rust module", () => {
  const runtime = structuralRustFixture({ "src/lib.rs": "mod outer { pub mod child; }\n", "src/outer/child.rs": "pub fn child() {}\n" });
  expect(runtime.sidecar.discoveryLedger.find((item) => item.scope.selectedPaths.includes("src/outer/child.rs"))?.analysisOutcome).toBe("analyzed");
  expect(runtime.analysis.graph.nodes.some((node) => node.name === "child" && node.filePath === "src/outer/child.rs")).toBe(true);
});

test("an external Rust mod declaration links its parent and child files without a use statement", () => {
  const runtime = structuralRustFixture({ "src/lib.rs": "pub mod child;\n", "src/child.rs": "pub fn child() {}\n" });
  expect(runtime.analysis.graph.edges).toContainEqual(expect.objectContaining({
    kind: "imports", from: "mod:src/lib.rs", to: "mod:src/child.rs",
  }));
  expect(runtime.analysis.graph.edges.find((edge) => edge.kind === "imports" && edge.to === "mod:src/child.rs")?.evidence)
    .toContainEqual(expect.objectContaining({ filePath: "src/lib.rs", startLine: 1, excerpt: "pub mod child;" }));
});

test("does not publish an external cfg(test) module as ordinary source", () => {
  const runtime = structuralRustFixture({ "src/lib.rs": "#[cfg(test)] mod tests;\n", "src/tests.rs": "pub fn helper() {}\n" });
  expect(runtime.sidecar.discoveryLedger.find((item) => item.scope.selectedPaths.includes("src/tests.rs"))?.analysisOutcome).toBe("unsupported");
  expect(runtime.analysis.graph.nodes.some((node) => node.name === "helper")).toBe(false);
});

test("refuses structural Rust authority for a manifest with an invalid package version", () => {
  const runtime = structuralRustFixture({ "Cargo.toml": '[package]\nname = "bounded"\nversion = "invalid semver"\nedition = "2021"\n',
    "src/lib.rs": "pub fn value() {}\n" });
  expect(runtime.sidecar.discoveryLedger.find((item) => item.scope.selectedPaths.includes("src/lib.rs"))?.analysisOutcome).toBe("unsupported");
  expect(runtime.analysis.graph.nodes.some((node) => node.name === "value")).toBe(false);
});
