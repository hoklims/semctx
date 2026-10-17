import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractRust } from "../src/index";
import { resolveRustNavigation } from "../src/navigation";
import type { RustNavigationConfig } from "@semantic-context/core";

function nativeConfig(): RustNavigationConfig {
  const rustAnalyzerPath = process.env.SEMCTX_TEST_RUST_ANALYZER;
  const toolchainRoot = process.env.SEMCTX_TEST_RUST_TOOLCHAIN;
  const target = process.env.SEMCTX_TEST_RUST_TARGET;
  if (rustAnalyzerPath === undefined || toolchainRoot === undefined || target === undefined) throw new Error("Rust integration tooling is required");
  return { mode: "navigation", trusted: true, rustAnalyzerPath, rustAnalyzerSha256: createHash("sha256").update(readFileSync(rustAnalyzerPath)).digest("hex"), toolchainRoot, target, features: [], budgetMs: 30_000 };
}

test("pinned rust-analyzer resolves a cross-crate alias against retained source declarations", async () => {
  const rustAnalyzerPath = process.env.SEMCTX_TEST_RUST_ANALYZER;
  const toolchainRoot = process.env.SEMCTX_TEST_RUST_TOOLCHAIN;
  const target = process.env.SEMCTX_TEST_RUST_TARGET;
  if (rustAnalyzerPath === undefined || toolchainRoot === undefined || target === undefined) {
    throw new Error("Rust integration requires SEMCTX_TEST_RUST_ANALYZER, SEMCTX_TEST_RUST_TOOLCHAIN and SEMCTX_TEST_RUST_TARGET");
  }
  const root = resolve(import.meta.dir, "../../../examples/sample-rust-repo");
  const paths = ["domain/src/lib.rs", "domain/src/capacity.rs", "domain/src/reservation.rs", "domain/tests/confirmation.rs", "app/src/main.rs"];
  const files = paths.map((relPath) => ({ relPath, source: readFileSync(resolve(root, relPath), "utf8") }));
  const metadata = ["Cargo.toml", "Cargo.lock", "domain/Cargo.toml", "app/Cargo.toml"].map((relPath) => ({ relPath, source: readFileSync(resolve(root, relPath), "utf8") }));
  const extraction = await extractRust(files);
  const result = await resolveRustNavigation({ files, metadata, extraction, config: {
    mode: "navigation", trusted: true, rustAnalyzerPath,
    rustAnalyzerSha256: createHash("sha256").update(readFileSync(rustAnalyzerPath)).digest("hex"),
    toolchainRoot, target, features: [], budgetMs: 30_000,
  } });
  expect(result.relations.some(({ queryIndex, symbolIndex }) => extraction.queries[queryIndex]?.relPath === "app/src/main.rs"
    && extraction.queries[queryIndex]?.kind === "call" && extraction.symbols[symbolIndex]?.name === "confirm"
    && extraction.symbols[symbolIndex]?.relPath === "domain/src/reservation.rs")).toBe(true);
  expect(result.identity).toMatch(/^sha256:[0-9a-f]{64}$/);
}, 40_000);

test("refuses ambiguous globs without publishing the singleton navigation target", async () => {
  const files = [{ relPath: "src/lib.rs", source: "mod a { pub fn shared() {} } mod b { pub fn shared() {} } use a::*; use b::*; pub fn run() { shared(); }" }];
  const extraction = await extractRust(files);
  const result = await resolveRustNavigation({ files, metadata: [{ relPath: "Cargo.toml", source: '[package]\nname="ambiguous"\nversion="0.1.0"\nedition="2021"\n' }], extraction, config: nativeConfig() });
  expect(result.relations).toEqual([]);
  expect(result.unresolved).toEqual([{ queryIndex: 0, reason: "RUST_GLOB_IMPORT_PROFILE_REFUSED" }]);
}, 40_000);

test("navigation resolves a call after a non-BMP character but leaves function-value dispatch unresolved", async () => {
  const source = 'pub fn target() {}\npub fn invoke(f: fn()) { f(); }\npub fn run() { let crab = "🦀"; target(); invoke(target); }\n';
  const files = [{ relPath: "src/lib.rs", source }];
  const extraction = await extractRust(files);
  const result = await resolveRustNavigation({ files, extraction,
    metadata: [{ relPath: "Cargo.toml", source: '[package]\nname="positions"\nversion="0.1.0"\nedition="2021"\n' }],
    config: nativeConfig() });
  const resolved = result.relations.map(({ queryIndex, symbolIndex }) => ({
    caller: extraction.queries[queryIndex]?.scope.join("."),
    written: source.slice(extraction.queries[queryIndex]!.target.startOffset, extraction.queries[queryIndex]!.target.endOffset),
    target: extraction.symbols[symbolIndex]?.name,
  }));
  expect(resolved).toContainEqual({ caller: "run", written: "target", target: "target" });
  expect(resolved).toContainEqual({ caller: "run", written: "invoke", target: "invoke" });
  expect(resolved.some((relation) => relation.caller === "invoke" && relation.written === "f")).toBe(false);
  expect(result.unresolved.some(({ queryIndex }) => extraction.queries[queryIndex]?.scope.join(".") === "invoke")).toBe(true);
}, 40_000);

test("rejects external dependencies and escaping workspace members before Cargo loading", async () => {
  const files = [{ relPath: "src/lib.rs", source: "pub fn value() -> u32 { 1 }" }];
  const extraction = await extractRust(files);
  const manifest = '[package]\nname="bounded"\nversion="0.1.0"\nedition="2021"\n';
  await rejects(resolveRustNavigation({ files, extraction, config: nativeConfig(), metadata: [{ relPath: "Cargo.toml", source: manifest + '[dependencies]\nexternal="1"\n' }] }), /RUST_EXTERNAL_DEPENDENCY_UNQUALIFIED/);
  await rejects(resolveRustNavigation({ files, extraction, config: nativeConfig(), metadata: [{ relPath: "Cargo.toml", source: manifest + '[workspace]\nmembers=["../escape"]\n' }] }), /RUST_PATH_OUTSIDE_REPOSITORY/);
}, 40_000);
