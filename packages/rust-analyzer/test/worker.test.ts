import { expect, test } from "bun:test";
import { extractRust, extractRustSync } from "../src/index";

test("the real Bun worker retains extraction bytes and refuses invalid input", async () => {
  const files = [{ relPath: "src/lib.rs", source: "pub fn quote() -> u32 { 3 }" }];
  expect(extractRustSync(files)).toEqual(await extractRust(files));
  expect(() => extractRustSync([{ relPath: "../escape.rs", source: "fn f() {}" }])).toThrow("RUST_WORKER_FAILED");
});

test("a worker deadline fails visibly", () => {
  expect(() => extractRustSync([{ relPath: "lib.rs", source: "fn f() {}" }], { budgetMs: 1 })).toThrow("RUST_WORKER_TIMEOUT");
});
