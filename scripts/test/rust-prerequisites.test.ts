import { expect, test } from "bun:test";
import { dirname, resolve } from "node:path";

test("contributor inspection exposes absent Rust and Cargo before the native gate is launched", () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"));
  env.PATH = dirname(process.execPath);
  const result = Bun.spawnSync([process.execPath, "scripts/contributor.ts", "inspect", "--json"], {
    cwd: resolve(import.meta.dir, "../.."), env, stdout: "pipe", stderr: "pipe", timeout: 15_000,
  });
  const report = JSON.parse(result.stdout.toString()) as { prerequisites: { id: string; status: string; recovery: string | null }[] };
  for (const id of ["rustc", "cargo"]) {
    const prerequisite = report.prerequisites.find(item => item.id === id);
    expect(prerequisite, `${id} must be an explicit prerequisite`).toBeDefined();
    expect(prerequisite?.status).toBe("absent");
    expect(prerequisite?.recovery).toContain("rustup");
  }
});
