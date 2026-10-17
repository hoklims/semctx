import { expect, test } from "bun:test";
import { copyFileSync, cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { SAMPLE_RUST_REPO } from "@semantic-context/test-fixtures";
import { discoverRepository } from "@semantic-context/ts-analyzer";
import { analyzePlaneARuntime, analyzePlaneARuntimeAsync } from "../src/plane-a-runtime";
import { fingerprintAnalysisInputs } from "../src/freshness";
import { dbPath, initWorkspace } from "@semantic-context/repository-store";
import { indexHealth, indexRepository, runChangeImpact, runVerify } from "../src";
import { __setIndexRepositoryCaptureBarrierForTesting } from "../src/indexing";

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
    mkdirSync(join(toolchainRoot, "bin"), { recursive: true });
    mkdirSync(join(toolchainRoot, "lib/rustlib/src/rust/library"), { recursive: true });
    mkdirSync(join(toolchainRoot, "lib/rustlib/aarch64-apple-darwin/lib"), { recursive: true });
    writeFileSync(analyzer, "analyzer-v1");
    writeFileSync(join(toolchainRoot, "bin/rustc"), "compiler-v1");
    writeFileSync(join(toolchainRoot, "bin/cargo"), "cargo-v1");
    writeFileSync(join(toolchainRoot, "lib/rustlib/src/rust/library/lib.rs"), "source-v1");
    writeFileSync(join(toolchainRoot, "lib/rustlib/aarch64-apple-darwin/lib/libstd.rlib"), "stdlib-v1");
    const config = { ...createGlobSelectionConfig(root), languages: { rust: "on" as const },
      rust: { mode: "navigation" as const, trusted: true as const, rustAnalyzerPath: analyzer,
        rustAnalyzerSha256: createHash("sha256").update("analyzer-v1").digest("hex"),
        toolchainRoot, target: "aarch64-apple-darwin", features: [], budgetMs: 30_000 } };
    const baseline = fingerprintAnalysisInputs(config, []);
    writeFileSync(join(toolchainRoot, "bin/rustc"), "compiler-v2");
    expect(fingerprintAnalysisInputs(config, [])).not.toBe(baseline);
    writeFileSync(join(toolchainRoot, "bin/rustc"), "compiler-v1");
    expect(fingerprintAnalysisInputs(config, [])).toBe(baseline);
    rmSync(join(toolchainRoot, "lib/rustlib/src/rust/library/lib.rs"));
    expect(fingerprintAnalysisInputs(config, [])).not.toBe(baseline);
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
    expect(rustDecisions.every((decision) => decision.gates.negativeCompleteness !== "passed")).toBe(true);
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
    expect(impact.changes.units?.some((unit) => unit.id === "sym:function:domain/src/reservation.rs:confirm")).toBe(false);
    expect(impact.unresolved?.some((item) => item.code === "RUST_ANALYSIS_PARTIAL" && item.file === "domain/src/reservation.rs")).toBe(true);
    expect(impact.explicitlyUnaffected).toEqual([]);
    const verification = runVerify(root, { kind: "working-tree" }).report;
    expect(verification.verdict).toBe("BLOCK");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

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
