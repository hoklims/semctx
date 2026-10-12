import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { analyzerIdentity, generatedAnalyzerIdentity } from "./analyzer-identity";

test("built analyzer identity binds exact implementation and compiler bytes", () => {
  const root = resolve(import.meta.dir, "..");
  expect(readFileSync(resolve(root, "packages/app-services/src/analyzer-identity-generated.ts"), "utf8")).toBe(generatedAnalyzerIdentity(root));
});

test("analyzer identity covers the independent Git runtime inventory", () => {
  const root = resolve(import.meta.dir, "..");
  const inventory = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  expect(inventory.exitCode).toBe(0);
  const fixed = new Set(["bun.lock", "tsconfig.json", "tsconfig.base.json", "scripts/analyzer-identity.ts", "scripts/build-plugin-runtime.ts", "scripts/build-cli-package.ts"]);
  const expected = new TextDecoder().decode(inventory.stdout).split("\0").filter((path) =>
    fixed.has(path) || (/^(?:packages\/[^/]+|apps\/cli)\/(?:package\.json|src\/.*\.(?:ts|js|mjs))$/.test(path)
      && path !== "packages/app-services/src/analyzer-identity-generated.ts"));
  const identity = analyzerIdentity(root);
  expect(identity.files.map((file) => file.path)).toEqual(expected.sort());
  const canonical = Bun.spawnSync(["git", "cat-file", "--batch"], {
    cwd: root, stdin: Buffer.from(expected.map((path) => `:${path}\n`).join("")), stdout: "pipe", stderr: "pipe",
  });
  expect(canonical.exitCode).toBe(0);
  const bytes = Buffer.from(canonical.stdout);
  let offset = 0;
  const files = expected.map((path) => {
    const newline = bytes.indexOf(10, offset);
    const header = bytes.subarray(offset, newline).toString("utf8").split(" ");
    expect(header[1]).toBe("blob");
    const size = Number(header[2]);
    const content = bytes.subarray(newline + 1, newline + 1 + size);
    offset = newline + 1 + size + 1;
    expect({ path, crlf: content.includes("\r\n") }).toEqual({ path, crlf: false });
    return { path, digest: `sha256:${createHash("sha256").update(content).digest("hex")}` };
  });
  expect(offset).toBe(bytes.length);
  expect(identity.files).toEqual(files);
});

test("analyzer identity producer binds canonical LF bytes and refuses CRLF without rewriting inputs", () => {
  const repository = resolve(import.meta.dir, "..");
  const root = mkdtempSync(join(tmpdir(), "semctx-analyzer-identity-"));
  const source = "export const value = 1;\n";
  const fixture = {
    "bun.lock": "{}\n",
    "tsconfig.json": "{}\n",
    "tsconfig.base.json": "{}\n",
    "scripts/analyzer-identity.ts": readFileSync(resolve(repository, "scripts/analyzer-identity.ts"), "utf8"),
    "scripts/build-plugin-runtime.ts": "export {};\n",
    "scripts/build-cli-package.ts": "export {};\n",
    "packages/app-services/package.json": "{}\n",
    "packages/app-services/src/value.ts": source,
    "apps/cli/package.json": "{}\n",
  };
  try {
    for (const [path, bytes] of Object.entries(fixture)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), bytes);
    }
    mkdirSync(join(root, "apps/cli/src"));
    mkdirSync(join(root, "node_modules"));
    symlinkSync(resolve(Bun.resolveSync("typescript", repository), "../.."), join(root, "node_modules/typescript"), "junction");
    const input = "packages/app-services/src/value.ts";
    writeFileSync(join(root, ".gitattributes"), "* text eol=lf\n");
    for (const args of [["init", "--quiet"], ["add", ".gitattributes", input]]) {
      expect(Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
    }
    const canonical = Bun.spawnSync(["git", "show", `:${input}`], { cwd: root, stdout: "pipe", stderr: "pipe" });
    expect(canonical.exitCode).toBe(0);
    expect(new TextDecoder().decode(canonical.stdout)).toBe(source);
    expect(analyzerIdentity(root).files.find((file) => file.path === input)?.digest)
      .toBe(`sha256:${createHash("sha256").update(canonical.stdout).digest("hex")}`);
    const entry = join(root, "scripts/analyzer-identity.ts");
    const generate = Bun.spawnSync([process.execPath, entry], { cwd: root, stdout: "pipe", stderr: "pipe" });
    expect(generate.exitCode).toBe(0);
    const output = join(root, "packages/app-services/src/analyzer-identity-generated.ts");
    const before = readFileSync(output);
    const crlf = source.replaceAll("\n", "\r\n");
    writeFileSync(join(root, input), crlf);
    const refused = Bun.spawnSync([process.execPath, entry], { cwd: root, stdout: "pipe", stderr: "pipe" });
    expect(refused.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(refused.stderr)).toContain(`Noncanonical CRLF analyzer input: ${input}`);
    expect(readFileSync(join(root, input), "utf8")).toBe(crlf);
    expect(readFileSync(output)).toEqual(before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
