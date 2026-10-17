import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractRust } from "../src/index";

test("extracts pinned pico-args declarations from real Rust 2018 source", async () => {
  const source = readFileSync(join(import.meta.dir, "corpus/pico-args-0.5.0/src/lib.rs"), "utf8");
  expect(createHash("sha256").update(source).digest("hex")).toBe("a3bec80854f4b259944720f3d984de4da19b230e24010e1fac374f6f32cc6865");
  const result = await extractRust([{ relPath: "src/lib.rs", source }]);
  for (const [name, kind] of [["Error", "enum"], ["Arguments", "type"], ["Keys", "type"]]) {
    expect(result.symbols).toContainEqual(expect.objectContaining({ name, kind, relPath: "src/lib.rs" }));
  }
  expect(result.limitations.some((limitation) => limitation.kind === "parse-error")).toBe(false);
  expect(result.symbols.find((symbol) => symbol.name === "Arguments")?.visibility).toBe("pub");
});
