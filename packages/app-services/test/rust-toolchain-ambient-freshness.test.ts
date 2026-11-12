import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { rustToolchainIdentity } from "@semantic-context/rust-analyzer";
import { gitEnvironment } from "../../../plugins/shared/hooks/process-budget.mjs";
import { fingerprintAnalysisInputs } from "../src/freshness";

test("external Rust sysroot ancestor config invalidates ordinary and qualified input binding", () => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "semctx-rust-external-sdk-binding-")));
  try {
    const project = join(fixture, "project");
    const toolchainRoot = join(fixture, "sdk", "toolchain");
    const analyzer = join(fixture, "sdk", "rust-analyzer");
    const library = join(toolchainRoot, "lib", "rustlib", "src", "rust", "library");
    const target = "aarch64-apple-darwin";
    const executable = process.platform === "win32" ? ".exe" : "";
    mkdirSync(project);
    const initialized = Bun.spawnSync(["git", "init", "-q"], { cwd: project, env: gitEnvironment(), stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    if (initialized.exitCode !== 0) throw new Error(new TextDecoder().decode(initialized.stderr));
    mkdirSync(join(toolchainRoot, "bin"), { recursive: true });
    mkdirSync(join(toolchainRoot, "lib", "rustlib", target, "lib"), { recursive: true });
    mkdirSync(join(library, ".cargo"), { recursive: true });
    mkdirSync(join(library, "vendor"), { recursive: true });
    writeFileSync(join(project, "Cargo.toml"), '[package]\nname="binding"\nversion="0.1.0"\nedition="2021"\n');
    writeFileSync(analyzer, "fake-analyzer-hashed-never-executed");
    writeFileSync(join(toolchainRoot, "bin", `rustc${executable}`), "fake-rustc-hashed-never-executed");
    writeFileSync(join(toolchainRoot, "bin", `cargo${executable}`), "fake-cargo-hashed-never-executed");
    writeFileSync(join(toolchainRoot, "lib", "rustlib", target, "lib", "libstd.rlib"), "fake-target-library");
    writeFileSync(join(library, "lib.rs"), "pub fn retained() {}\n");
    writeFileSync(join(library, "vendor", "retained.txt"), "content-bound-vendor");
    writeFileSync(join(library, ".cargo", "config.toml"),
      '[source.crates-io]\nreplace-with="vendored-sources"\n[source.vendored-sources]\ndirectory="vendor"\n');
    const navigation = {
      mode: "navigation" as const, trusted: true as const, rustAnalyzerPath: analyzer,
      rustAnalyzerSha256: createHash("sha256").update("fake-analyzer-hashed-never-executed").digest("hex"),
      toolchainRoot, target, features: [], budgetMs: 30_000,
    };
    const config = {
      ...createGlobSelectionConfig(project), languages: { rust: "on" as const }, rust: navigation,
    };
    const qualified = {
      ...config, selectionMode: "qualified-static-v1" as const,
      analysisProfile: "public-monorepo-static-v1" as const,
    };
    const withoutNavigation = { ...config, rust: undefined };
    // Fake toolchain files are hashed, never executed; intrinsic configuration stays bound.
    const identityBefore = rustToolchainIdentity(navigation);
    const ordinaryBefore = fingerprintAnalysisInputs(config, []);
    const qualifiedBefore = fingerprintAnalysisInputs(qualified, []);
    const projectBefore = fingerprintAnalysisInputs(withoutNavigation, []);

    const ambient = join(dirname(realpathSync(library)), ".cargo");
    mkdirSync(ambient);
    writeFileSync(join(ambient, "config.toml"), '[net]\noffline=true\n');
    expect(fingerprintAnalysisInputs(withoutNavigation, [])).toBe(projectBefore);
    expect(fingerprintAnalysisInputs(config, [])).not.toBe(ordinaryBefore);
    expect(fingerprintAnalysisInputs(qualified, [])).not.toBe(qualifiedBefore);
    expect(() => rustToolchainIdentity(navigation)).toThrow("RUST_CARGO_CONFIGURATION_UNSUPPORTED");

    rmSync(ambient, { recursive: true });
    expect(rustToolchainIdentity(navigation)).toBe(identityBefore);
    expect(fingerprintAnalysisInputs(config, [])).toBe(ordinaryBefore);
    expect(fingerprintAnalysisInputs(qualified, [])).toBe(qualifiedBefore);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
