import { expect, test } from "bun:test";
import { createGlobSelectionConfig, SemctxConfigSchema } from "../src";

test("retains an explicit pinned and trusted Rust navigation configuration", () => {
  const rust = { mode: "navigation", trusted: true, rustAnalyzerPath: "/tools/rust-analyzer", rustAnalyzerSha256: "a".repeat(64), toolchainRoot: "/tools/rust", target: "aarch64-apple-darwin", features: [], budgetMs: 60_000 };
  const config = { ...createGlobSelectionConfig("/repo"), languages: { rust: "on" }, rust };
  expect(SemctxConfigSchema.parse(config)).toHaveProperty("rust", rust);
  expect(SemctxConfigSchema.safeParse({ ...config, rust: { ...rust, trusted: false } }).success).toBe(false);
  expect(SemctxConfigSchema.safeParse({ ...config, rust: { ...rust, rustAnalyzerSha256: "unknown" } }).success).toBe(false);
});
