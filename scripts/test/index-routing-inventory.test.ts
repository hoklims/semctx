import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("index routing inventories every bundled test and refuses incomplete evidence", () => {
  const result = Bun.spawnSync(
    ["python", "-B", "scripts/test/test_index_routing_inventory.py"],
    { cwd: resolve(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" },
  );
  expect(result.exitCode, result.stderr.toString()).toBe(0);
});
