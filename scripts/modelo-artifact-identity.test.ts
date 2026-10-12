import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateQualificationInputs, artifactFiles } from "./modelo-artifact-identity";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString().trim();
}
function inputs() {
  const root = mkdtempSync(join(tmpdir(), "qualified-artifacts-")); roots.push(root);
  mkdirSync(join(root, "payload"));
  mkdirSync(join(root, "compiler"));
  writeFileSync(join(root, "compiler/package.json"), JSON.stringify({ version: "test-compiler" }));
  writeFileSync(join(root, "compiler/typescript.js"), "compiler");
  writeFileSync(join(root, "payload/semctx.js"), "entry");
  writeFileSync(join(root, "payload/semctx-shared.js"), "shared");
  writeFileSync(join(root, "payload/semctx-index-worker.js"), "worker");
  git(root, "init", "-q"); git(root, "add", ".");
  git(root, "-c", "user.name=Fixture", "-c", "user.email=f@example.test", "commit", "-qm", "fixture");
  const payloadRoot = mkdtempSync(join(tmpdir(), "consumed-artifacts-")); roots.push(payloadRoot);
  cpSync(join(root, "payload"), payloadRoot, { recursive: true });
  const manifest = {
    schemaVersion: 1, source: { commit: git(root, "rev-parse", "HEAD"), tree: git(root, "rev-parse", "HEAD^{tree}") },
    runtime: { version: Bun.version, sha256: sha(readFileSync(process.execPath)) },
    compiler: { root: join(root, "compiler"), version: "test-compiler", files: artifactFiles(join(root, "compiler")) },
    payloads: [{ root: payloadRoot, source: "candidate", sourceIdentity: git(root, "rev-parse", "HEAD"), releaseGitDirectory: "payload", entries: { "plugin-cli": "semctx.js" },
      files: ["semctx-index-worker.js", "semctx-shared.js", "semctx.js"].map(path => ({ path, sha256: sha(readFileSync(join(root, "payload", path))) })) }],
  };
  return { sourceRoot: root, payloadRoot, manifest, entries: { "plugin-cli": join(payloadRoot, "semctx.js") } };
}
test("candidate complete declared payload and frozen source validate", () => {
  expect(() => validateQualificationInputs(inputs())).not.toThrow();
});
test("unchanged entry does not conceal a shared-chunk substitution", () => {
  const input = inputs(); writeFileSync(join(input.payloadRoot, "semctx-shared.js"), "wrong shared");
  expect(git(input.sourceRoot, "status", "--porcelain", "--untracked-files=all")).toBe("");
  expect(() => validateQualificationInputs(input)).toThrow(`${input.payloadRoot}: complete artifact inventory/bytes differ`);
});
test("missing payload dependencies refuse", () => {
  const input = inputs(); rmSync(join(input.payloadRoot, "semctx-index-worker.js"));
  expect(git(input.sourceRoot, "status", "--porcelain", "--untracked-files=all")).toBe("");
  expect(() => validateQualificationInputs(input)).toThrow(`${input.payloadRoot}: complete artifact inventory/bytes differ`);
});
test("unexpected payload dependencies refuse", () => {
  const input = inputs(); writeFileSync(join(input.payloadRoot, "unexpected.js"), "extra");
  expect(git(input.sourceRoot, "status", "--porcelain", "--untracked-files=all")).toBe("");
  expect(() => validateQualificationInputs(input)).toThrow(`${input.payloadRoot}: complete artifact inventory/bytes differ`);
});
test("unavailable, mismatched and dirty candidate source refuse", () => {
  const input = inputs(); input.manifest.source.commit = "0".repeat(40);
  expect(() => validateQualificationInputs(input)).toThrow();
  input.manifest.source.commit = git(input.sourceRoot, "rev-parse", "HEAD");
  writeFileSync(join(input.sourceRoot, "dirty.txt"), "dirty");
  expect(() => validateQualificationInputs(input)).toThrow();
  const unavailable = mkdtempSync(join(tmpdir(), "no-git-")); roots.push(unavailable);
  expect(() => validateQualificationInputs({ ...input, sourceRoot: unavailable })).toThrow();
});
test("candidate role cannot be replaced with a historical artifact", () => {
  const input = inputs(); input.manifest.payloads[0]!.source = "historical";
  expect(() => validateQualificationInputs(input)).toThrow();
});

test("historical bytes remain usable without claiming candidate source identity", () => {
  const input = inputs();
  const historical = join(input.sourceRoot, "historical"); mkdirSync(historical);
  writeFileSync(join(historical, "index.js"), "original historical regression");
  git(input.sourceRoot, "add", "."); git(input.sourceRoot, "-c", "user.name=Fixture", "-c", "user.email=f@example.test", "commit", "-qm", "historical bytes");
  input.manifest.source.commit = git(input.sourceRoot, "rev-parse", "HEAD");
  input.manifest.source.tree = git(input.sourceRoot, "rev-parse", "HEAD^{tree}");
  input.manifest.payloads[0]!.sourceIdentity = input.manifest.source.commit;
  const complete = { ...input, entries: { ...input.entries, "regression-cli": join(historical, "index.js") }, manifest: { ...input.manifest, payloads: [...input.manifest.payloads, {
    root: historical, source: "historical", sourceIdentity: "UNKNOWN", entries: { "regression-cli": "index.js" }, files: artifactFiles(historical),
  }] } };
  expect(() => validateQualificationInputs(complete)).not.toThrow();
  complete.manifest.payloads[1]!.sourceIdentity = input.manifest.source.commit;
  expect(() => validateQualificationInputs(complete)).toThrow();
});
test("runtime and compiler byte substitutions refuse", () => {
  const input = inputs(); input.manifest.runtime.sha256 = "0".repeat(64);
  expect(() => validateQualificationInputs(input)).toThrow();
  input.manifest.runtime.sha256 = sha(readFileSync(process.execPath));
  writeFileSync(join(input.sourceRoot, "compiler/typescript.js"), "different compiler");
  git(input.sourceRoot, "add", "."); git(input.sourceRoot, "-c", "user.name=Fixture", "-c", "user.email=f@example.test", "commit", "-qm", "compiler substitute");
  input.manifest.source.commit = git(input.sourceRoot, "rev-parse", "HEAD"); input.manifest.source.tree = git(input.sourceRoot, "rev-parse", "HEAD^{tree}");
  input.manifest.payloads[0]!.sourceIdentity = input.manifest.source.commit;
  expect(() => validateQualificationInputs(input)).toThrow();
});
test("candidate installed payload requires exact frozen generation outputs", () => {
  const input = inputs();
  const candidate = input.manifest.payloads[0]!;
  const { releaseGitDirectory: _directory, ...withoutGit } = candidate;
  const complete = { ...input, manifest: { ...input.manifest, payloads: [{ ...withoutGit, generation: {
    sourceCommit: input.manifest.source.commit, sourceTree: input.manifest.source.tree,
    command: [process.execPath, "scripts/build-cli-package.ts"], exitCode: 0, files: candidate.files,
  } }] } };
  expect(() => validateQualificationInputs(complete)).not.toThrow();
  complete.manifest.payloads[0]!.generation.sourceCommit = "0".repeat(40);
  expect(() => validateQualificationInputs(complete)).toThrow();
  complete.manifest.payloads[0]!.generation.sourceCommit = input.manifest.source.commit;
  complete.manifest.payloads[0]!.generation.files = candidate.files.slice(1);
  expect(() => validateQualificationInputs(complete)).toThrow();
});
