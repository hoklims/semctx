import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig, VerifyReportSchema } from "@semantic-context/core";
import { initWorkspace } from "@semantic-context/repository-store";
import { indexRepository, runVerify } from "../src";
import { __setVerificationAttributeBarrierForTesting } from "../src/verification-state";
import { __setVerifyControlBarrierForTesting } from "../src/verify";

const roots: string[] = [];
const CLI = join(import.meta.dir, "../../../apps/cli/src/index.ts");

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

function repository(removal = false): string {
  const root = mkdtempSync(join(tmpdir(), "semctx-qualified-post-image-"));
  roots.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, ".gitignore"), ".semctx/\n");
  writeFileSync(join(root, "src/main.ts"), "export function main(){return 1;}\n");
  writeFileSync(join(root, ".gitattributes"), "src/*.ts filter=broken\n");
  git(root, "init", "-q"); git(root, "config", "core.autocrlf", "false");
  git(root, "add", "."); git(root, "commit", "-qm", "base");
  initWorkspace(root, { ...createGlobSelectionConfig(root), selectionMode: "qualified-static-v1", analysisProfile: "modelo-suite-static-v1", include: ["src/**/*"], languages: { typescript: "on", javascript: "on" } });
  if (removal) writeFileSync(join(root, "src/main.ts"), "export function main(){return 2;}\n");
  else writeFileSync(join(root, "src/added.ts"), "export function added(){return 2;}\n");
  git(root, "add", "."); git(root, "commit", "-qm", "head");
  indexRepository(root, "2026-10-12T00:00:00.000Z");
  return root;
}

function failingConversion(root: string): void {
  git(root, "status", "--porcelain");
  git(root, "config", "filter.broken.clean", "false");
  git(root, "config", "filter.broken.required", "true");
}

function observed(root: string): { report: ReturnType<typeof runVerify>["report"] | undefined; failure: unknown } {
  let report: ReturnType<typeof runVerify>["report"] | undefined;
  let failure: unknown;
  try { report = runVerify(root, { kind: "range", base: "HEAD^" }).report; } catch (error) { failure = error; }
  return { report, failure };
}

afterEach(() => {
  __setVerificationAttributeBarrierForTesting(undefined);
  __setVerifyControlBarrierForTesting(undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("clean pure addition retains qualified admission", () => {
  const { report, failure } = observed(repository());
  expect(failure).toBeUndefined();
  expect(VerifyReportSchema.safeParse(report).success).toBe(true);
  expect(report?.analysisAdmission?.status).toBe("admitted");
  expect(report?.analysisAdmission?.binding.status).toBe("valid");
  expect(report?.analysisAdmission?.indexFreshness.verdict).toBe("FRESH");
  expect(report?.analysisAdmission?.changeCoverage.analyzed).toEqual(["src/added.ts"]);
});

test("attribute drift during retained comparison returns structured invalid binding", () => {
  const root = repository();
  __setVerifyControlBarrierForTesting(() => __setVerificationAttributeBarrierForTesting(() => writeFileSync(join(root, ".git/info/attributes"), "src/*.ts ident\n")));
  const { report, failure } = observed(root);
  console.info(JSON.stringify({ failure, report }));
  expect(failure).toBeUndefined();
  expect(VerifyReportSchema.safeParse(report).success).toBe(true);
  expect(report?.verdict).toBe("BLOCK");
  expect(report?.analysisAdmission?.status).toBe("rejected");
  expect(report?.analysisAdmission?.binding.status).toBe("invalid");
  expect(report?.analysisAdmission?.binding.reasons).toContain("QUALIFIED_POST_IMAGE_ATTRIBUTES_UNBOUND");
  expect(report?.analysisAdmission?.indexFreshness.verdict).toBe("FRESH");
  expect(report?.analysisAdmission?.changeCoverage.analyzed).toEqual(["src/added.ts"]);
  rmSync(join(root, ".git/info/attributes"));
  const entry = join(root, ".git/attribute-cli.ts");
  const module = (path: string): string => JSON.stringify(join(import.meta.dir, path).replaceAll("\\", "/"));
  writeFileSync(entry, `import {writeFileSync} from "node:fs";
import {join} from "node:path";
import {__setVerifyControlBarrierForTesting} from ${module("../src/verify.ts")};
import {__setVerificationAttributeBarrierForTesting} from ${module("../src/verification-state.ts")};
import {runVerifyDiff} from ${module("../../../apps/cli/src/commands/verify.ts")};
import {parseArgs} from ${module("../../../apps/cli/src/args.ts")};
const root=process.argv[2]!;
__setVerifyControlBarrierForTesting(()=>__setVerificationAttributeBarrierForTesting(()=>writeFileSync(join(root,".git/info/attributes"),"src/*.ts ident\\n")));
process.exit(runVerifyDiff(root,parseArgs(["verify","diff","--base","HEAD^","--format","json","--fail-on","none"])));
`);
  const cli = Bun.spawnSync([process.execPath, entry, root], { stdout: "pipe", stderr: "pipe" });
  expect(cli.exitCode).toBe(3);
  const cliReport: unknown = JSON.parse(new TextDecoder().decode(cli.stdout));
  expect(VerifyReportSchema.safeParse(cliReport).success).toBe(true);
  expect(cliReport).toMatchObject({ verdict: "BLOCK", analysisAdmission: { status: "rejected", binding: { status: "invalid", reasons: ["QUALIFIED_POST_IMAGE_ATTRIBUTES_UNBOUND"] } } });
}, 60_000);

test("failed selected conversion returns rejected BLOCK and CLI exit 3 under advisory none", () => {
  const root = repository(); failingConversion(root);
  const { report, failure } = observed(root);
  console.info(JSON.stringify({ failure, report }));
  expect(failure).toBeUndefined();
  expect(VerifyReportSchema.safeParse(report).success).toBe(true);
  expect(report?.verdict).toBe("BLOCK");
  expect(report?.analysisAdmission?.status).toBe("rejected");
  expect(report?.analysisAdmission?.binding.status).toBe("invalid");
  expect(report?.analysisAdmission?.binding.reasons).toContain("QUALIFIED_POST_IMAGE_CONVERSION_FAILED");
  expect(report?.analysisAdmission?.indexFreshness.verdict).toBe("FRESH");
  expect(report?.analysisAdmission?.changeCoverage.analyzed).toEqual(["src/added.ts"]);
  const cli = Bun.spawnSync([process.execPath, CLI, "verify", "diff", "--root", root, "--base", "HEAD^", "--format", "json", "--fail-on", "none"], { stdout: "pipe", stderr: "pipe" });
  expect(cli.exitCode).toBe(3);
  const cliReport: unknown = JSON.parse(new TextDecoder().decode(cli.stdout));
  expect(VerifyReportSchema.safeParse(cliReport).success).toBe(true);
  expect(cliReport).toMatchObject({ verdict: "BLOCK", analysisAdmission: { status: "rejected", binding: { status: "invalid", reasons: ["QUALIFIED_POST_IMAGE_CONVERSION_FAILED"] } } });
}, 60_000);

test("explicit unsupported base recovery is not preempted by selected conversion", () => {
  const root = repository(true); failingConversion(root);
  const { report, failure } = observed(root);
  expect(failure).toBeUndefined();
  expect(VerifyReportSchema.safeParse(report).success).toBe(true);
  expect(report?.verdict).toBe("BLOCK");
  expect(report?.analysisAdmission?.status).toBe("rejected");
  expect(report?.analysisAdmission?.binding.reasons).toContain("QUALIFIED_BASE_RECOVERY_UNSUPPORTED");
  expect(report?.analysisAdmission?.binding.reasons).not.toContain("QUALIFIED_POST_IMAGE_CONVERSION_FAILED");
});


test("Git below the selected attribute prerequisite stays an operational diagnostic", () => {
  const root = repository();
  const original = Bun.spawnSync.bind(Bun);
  const spawn = spyOn(Bun, "spawnSync").mockImplementation(((command: string[], options: Parameters<typeof Bun.spawnSync>[1]) => {
    if (command[0] === "git" && command[1] === "--version") return { exitCode: 0, stdout: Buffer.from("git version 2.40.0\n"), stderr: Buffer.alloc(0) };
    return original(command, options);
  }) as typeof Bun.spawnSync);
  try {
    const { report, failure } = observed(root);
    expect(report).toBeUndefined();
    expect(failure).toMatchObject({ code: "UNSUPPORTED", message: "qualified staged/range verification requires Git >= 2.41 (--attr-source)" });
  } finally { spawn.mockRestore(); }
});
