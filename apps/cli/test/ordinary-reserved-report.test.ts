import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("ordinary reserved-report parent refuses a linked ancestor before directory creation", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-ordinary-reserved-report-"));
  const outside = mkdtempSync(join(tmpdir(), "semctx-ordinary-report-outside-"));
  try {
    mkdirSync(join(root, "src")); writeFileSync(join(root, ".gitignore"), ".semctx/\n");
    writeFileSync(join(root, "src/main.ts"), "export function main(){return 1;}\n");
    for (const args of [["init", "-q"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]]) {
      expect(Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
    }
    const cli = join(import.meta.dir, "../src/index.ts");
    for (const args of [["init"], ["index"]]) expect(Bun.spawnSync([process.execPath, cli, ...args, "--root", root], { cwd: join(import.meta.dir, "../../.."), stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
    writeFileSync(join(outside, "sentinel"), "outside bytes");
    symlinkSync(outside, join(root, ".semctx/reports"), process.platform === "win32" ? "junction" : "dir");
    const output = join(root, ".semctx/reports/missing-child/verify.json");
    const result = Bun.spawnSync([process.execPath, cli, "verify", "diff", "--root", root, "--format", "json", "--fail-on", "none", "--output", output], { cwd: join(import.meta.dir, "../../.."), stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(result.stderr)).toContain("[CONFIG_INVALID] linked .semctx entries are unsupported");
    expect(existsSync(join(outside, "missing-child"))).toBe(false);
    expect(readdirSync(outside)).toEqual(["sentinel"]);
    expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("outside bytes");
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
}, 60_000);
