import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "../packages/core/node_modules/zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const relativePath = z.string().refine(path => path.length > 0 && !path.includes("\\") && !path.startsWith("/") && !path.split("/").some(part => part === "." || part === ".." || part === ""), "canonical relative path required");
const file = z.object({ path: relativePath, sha256: digest }).strict();
const files = z.array(file).min(1);
const roles = ["cli", "mcp", "plugin-cli", "legacy-cli", "regression-cli", "directory-regression-cli", "loader-regression-cli"] as const;
const candidateRoles = new Set<string>(["cli", "mcp", "plugin-cli"]);
const payload = z.object({
  root: z.string(), source: z.enum(["candidate", "historical"]),
  sourceIdentity: z.union([commit, z.literal("UNKNOWN")]),
  entries: z.record(z.enum(roles), relativePath), files,
  releaseGitDirectory: relativePath.optional(),
  generation: z.object({ sourceCommit: commit, sourceTree: commit, command: z.array(z.string()).min(1), exitCode: z.literal(0), files }).strict().optional(),
}).strict();
export const QualificationInputManifestSchema = z.object({
  schemaVersion: z.literal(1), source: z.object({ commit, tree: commit }).strict(),
  runtime: z.object({ version: z.string(), sha256: digest }).strict(),
  compiler: z.object({ root: z.string(), version: z.string(), files }).strict(),
  payloads: z.array(payload).min(1),
}).strict();
export type QualificationInputManifest = z.infer<typeof QualificationInputManifestSchema>;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function artifactFiles(root: string): { path: string; sha256: string }[] {
  function visit(directory: string, prefix: string): { path: string; sha256: string }[] {
    assert(lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink(), `Unsupported artifact directory: ${directory}`);
    return readdirSync(directory).sort().flatMap(name => {
      const path = join(directory, name), relative = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(path);
      assert(!stat.isSymbolicLink(), `Linked artifact: ${relative}`);
      if (stat.isDirectory()) return visit(path, relative);
      assert(stat.isFile(), `Unsupported artifact: ${relative}`);
      return [{ path: relative, sha256: sha(readFileSync(path)) }];
    });
  }
  return visit(root, "").sort((a, b) => a.path.localeCompare(b.path, "en"));
}
function assertFiles(actual: { path: string; sha256: string }[], expected: { path: string; sha256: string }[], label: string): void {
  assert.equal(new Set(expected.map(file => file.path)).size, expected.length, `${label}: duplicate manifest file`);
  assert.deepEqual(actual, [...expected].sort((a, b) => a.path.localeCompare(b.path, "en")), `${label}: complete artifact inventory/bytes differ`);
}
function git(root: string, args: string[]): Uint8Array {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  assert.equal(result.exitCode, 0, `Source identity unavailable: git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout;
}

/** Validates independently supplied frozen inputs; it never authors generation provenance. */
export function validateQualificationInputs(input: { sourceRoot: string; manifest: unknown; entries: Record<string, string> }): QualificationInputManifest {
  const manifest = QualificationInputManifestSchema.parse(input.manifest);
  assert.equal(new TextDecoder().decode(git(input.sourceRoot, ["rev-parse", "HEAD"])).trim(), manifest.source.commit, "Candidate commit mismatch");
  assert.equal(new TextDecoder().decode(git(input.sourceRoot, ["rev-parse", "HEAD^{tree}"])).trim(), manifest.source.tree, "Candidate tree mismatch");
  assert.equal(new TextDecoder().decode(git(input.sourceRoot, ["status", "--porcelain", "--untracked-files=all"])).trim(), "", "Candidate source must be clean");
  assert.equal(manifest.runtime.version, Bun.version, "Runtime version mismatch");
  assert.equal(manifest.runtime.sha256, sha(readFileSync(process.execPath)), "Runtime bytes mismatch");
  assertFiles(artifactFiles(manifest.compiler.root), manifest.compiler.files, "Compiler");
  const compilerPackage = JSON.parse(readFileSync(join(manifest.compiler.root, "package.json"), "utf8")) as { version: string };
  assert.equal(compilerPackage.version, manifest.compiler.version, "Compiler version mismatch");
  const seen = new Set<string>();
  for (const payload of manifest.payloads) {
    assertFiles(artifactFiles(payload.root), payload.files, payload.root);
    const payloadPaths = new Set(payload.files.map(file => file.path));
    for (const [role, path] of Object.entries(payload.entries)) {
      assert(!seen.has(role), `Duplicate artifact role: ${role}`); seen.add(role);
      assert(payloadPaths.has(path), `Entrypoint absent from payload: ${role}`);
      assert(role in input.entries, `Unused manifest role: ${role}`);
      assert.equal(resolve(payload.root, path), resolve(input.entries[role]!), `Entrypoint mismatch: ${role}`);
      assert.equal(payload.source, candidateRoles.has(role) ? "candidate" : "historical", `Artifact cohort mismatch: ${role}`);
    }
    if (payload.source === "historical") {
      assert.equal(payload.sourceIdentity, "UNKNOWN", "Historical source identity stays unknown as originally recorded");
      assert(payload.releaseGitDirectory === undefined && payload.generation === undefined, "Historical bytes cannot acquire candidate provenance");
      continue;
    }
    assert.equal(payload.sourceIdentity, manifest.source.commit, "Candidate artifact source mismatch");
    assert(payload.releaseGitDirectory !== undefined || payload.generation !== undefined, "Candidate payload needs release Git objects or generation provenance");
    if (payload.releaseGitDirectory !== undefined) {
      const directory = payload.releaseGitDirectory;
      const paths = new TextDecoder().decode(git(input.sourceRoot, ["ls-tree", "-r", "--name-only", manifest.source.commit, "--", directory])).trim().split("\n").filter(Boolean).map(path => path.slice(directory.length + 1));
      assert.deepEqual([...payloadPaths].sort(), paths.sort(), "Release Git artifact inventory mismatch");
      for (const file of payload.files) assert.equal(sha(git(input.sourceRoot, ["show", `${manifest.source.commit}:${directory}/${file.path}`])), file.sha256, `Release Git bytes mismatch: ${file.path}`);
    }
    if (payload.generation !== undefined) {
      assert.equal(payload.generation.sourceCommit, manifest.source.commit, "Generation commit mismatch");
      assert.equal(payload.generation.sourceTree, manifest.source.tree, "Generation tree mismatch");
      assertFiles(payload.files, payload.generation.files, "Generation output");
    }
  }
  assert.deepEqual([...seen].sort(), Object.keys(input.entries).sort(), "Complete consumed artifact roles required");
  return manifest;
}
