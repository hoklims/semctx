import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { extractRust } from "../src/index";

test("extracts Rust declarations with impl identity and inline test scope", async () => {
  const result = await extractRust([{ relPath: "src/lib.rs", source: `
pub struct Amount(u32);
pub trait Quote { fn quote(&self) -> u32; }
impl Amount { pub fn new(value: u32) -> Self { Self(value) } }
impl Quote for Amount { fn quote(&self) -> u32 { self.0 } }
pub enum Outcome { Accepted, Rejected }
#[cfg(test)]
mod tests { #[test] fn positive_amount() { assert_eq!(Amount::new(3).quote(), 3); } }
` }]);
  expect(result.symbols.map(({ name, kind, scope }) => [name, kind, scope])).toEqual([
    ["Amount", "type", []],
    ["Quote", "type", []],
    ["quote", "function", ["trait Quote"]],
    ["impl Amount", "symbol", []],
    ["new", "function", ["impl Amount"]],
    ["impl Quote for Amount", "symbol", []],
    ["quote", "function", ["impl Quote for Amount"]],
    ["Outcome", "enum", []],
    ["tests", "module", []],
    ["positive_amount", "test", ["tests"]],
  ]);
});

test("preserves exact Unicode and CRLF ranges and only explicit documentation markers", async () => {
  const source = `// 🦀 ordinary @contract ignored\r\n#[doc = "@invariant positive: amount stays positive"]\r\npub fn café() -> u32 { 1 }\r\n`;
  const result = await extractRust([{ relPath: "src/lib.rs", source }]);
  const symbol = result.symbols[0]!;
  expect(source.slice(symbol.range.startOffset, symbol.range.endOffset)).toBe("pub fn café() -> u32 { 1 }");
  expect(symbol.nameRange).toMatchObject({ startLine: 3, startColumn: 8, endColumn: 12 });
  expect(symbol.markers).toEqual([expect.objectContaining({ tag: "invariant", slug: "positive", statement: "amount stays positive",
    range: expect.objectContaining({ startLine: 2, endLine: 2 }) })]);
});

test("keeps malformed, cfg, macro and glob limitations observable", async () => {
  const result = await extractRust([
    { relPath: "broken.rs", source: "pub fn broken( {" },
    { relPath: "src/lib.rs", source: "use left::*; #[cfg(feature = \"extra\")] fn gated() { generated!(); }" },
  ]);
  expect(result.limitations?.map(({ relPath, kind }) => [relPath, kind])).toEqual([
    ["broken.rs", "parse-error"],
    ["src/lib.rs", "glob-import"],
    ["src/lib.rs", "conditional-source"],
    ["src/lib.rs", "macro-expansion"],
  ]);
});

test("rejects noncanonical and duplicate source identities", async () => {
  for (const relPath of ["", "../outside.rs", "/tmp/outside.rs", "C:/outside.rs", "src/../lib.rs", "src\\lib.rs"]) {
    await rejects(extractRust([{ relPath, source: "fn f() {}" }]), /RUST_SOURCE_PATH_INVALID/);
  }
  await rejects(extractRust([{ relPath: "a.rs", source: "" }, { relPath: "a.rs", source: "fn f() {}" }]), /RUST_DUPLICATE_SOURCE/);
});

test("collects written import and call sites without claiming resolved targets", async () => {
  const source = "use crate::price::quote as price; fn run(value: Amount) { price(); value.quote(); unknown(); generated!(price()); }";
  const result = await extractRust([{ relPath: "src/lib.rs", source }]);
  expect(result.queries?.map((query) => [query.kind, source.slice(query.target.startOffset, query.target.endOffset)])).toEqual([
    ["import", "quote"], ["call", "price"], ["call", "quote"], ["call", "unknown"],
  ]);
  expect(result.queries?.every((query) => !("resolved" in query))).toBe(true);
});
