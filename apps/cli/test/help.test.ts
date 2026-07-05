import { describe, it, expect } from "bun:test";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "index.ts");

function run(args: string[]): { code: number; out: string } {
  const p = Bun.spawnSync(["bun", "run", CLI, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, out: new TextDecoder().decode(p.stdout) };
}

describe("help / usage exit codes", () => {
  it("`--help` is an explicit help request and exits 0", () => {
    const r = run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Usage: semctx");
  });

  it("the `help` command exits 0", () => {
    const r = run(["help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Usage: semctx");
  });

  it("a bare invocation (no command, no --help) is a usage error and exits 1", () => {
    const r = run([]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Usage: semctx");
  });

  it("an unknown command exits 2", () => {
    const r = run(["definitely-not-a-command"]);
    expect(r.code).toBe(2);
  });
});
