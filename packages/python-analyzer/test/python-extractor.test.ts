import { describe, expect, it } from "bun:test";
import { extractPython, type PythonExtraction } from "../src/index";

function extract(files: Record<string, string>): PythonExtraction {
  return extractPython(
    Object.entries(files).map(([relPath, source]) => ({ relPath, source })),
  );
}

describe("extractPython", () => {
  it("records modules and top-level function/class symbols in stable source order", () => {
    const result = extract({
      "src/example.py": [
        "class Account:",
        "    pass",
        "",
        "def settle(value: int) -> int:",
        "    return value",
        "",
      ].join("\n"),
    });

    expect(result.modules).toEqual([
      {
        relPath: "src/example.py",
        range: {
          startOffset: 0,
          endOffset: 73,
          startLine: 1,
          startColumn: 1,
          endLine: 6,
          endColumn: 1,
        },
      },
    ]);
    expect(result.symbols).toEqual([
      {
        name: "Account",
        kind: "class",
        relPath: "src/example.py",
        scope: [],
        range: {
          startOffset: 0,
          endOffset: 23,
          startLine: 1,
          startColumn: 1,
          endLine: 2,
          endColumn: 9,
        },
        markers: [],
      },
      {
        name: "settle",
        kind: "function",
        relPath: "src/example.py",
        scope: [],
        range: {
          startOffset: 25,
          endOffset: 72,
          startLine: 4,
          startColumn: 1,
          endLine: 5,
          endColumn: 17,
        },
        markers: [],
      },
    ]);
  });

  it("extracts static imports, aliases, and relative levels without inferring resolution", () => {
    const result = extract({
      "pkg/service.py": [
        "import os, json as js",
        "from .models import User, Role as UserRole",
        "from .. import shared",
        "",
      ].join("\n"),
    });

    expect(result.imports).toEqual([
      {
        kind: "import",
        fromRelPath: "pkg/service.py",
        module: "os",
        relativeLevel: 0,
        names: [{ name: "os" }],
        range: expect.objectContaining({ startLine: 1, endLine: 1 }),
      },
      {
        kind: "import",
        fromRelPath: "pkg/service.py",
        module: "json",
        relativeLevel: 0,
        names: [{ name: "json", alias: "js" }],
        range: expect.objectContaining({ startLine: 1, endLine: 1 }),
      },
      {
        kind: "from",
        fromRelPath: "pkg/service.py",
        module: "models",
        relativeLevel: 1,
        names: [{ name: "User" }, { name: "Role", alias: "UserRole" }],
        range: expect.objectContaining({ startLine: 2, endLine: 2 }),
      },
      {
        kind: "from",
        fromRelPath: "pkg/service.py",
        relativeLevel: 2,
        names: [{ name: "shared" }],
        range: expect.objectContaining({ startLine: 3, endLine: 3 }),
      },
    ]);
  });

  it("attaches markers only from an adjacent run of explicit hash comments", () => {
    const result = extract({
      "domain/orders.py": [
        "# @capability order-checkout",
        "# @invariant paid-once: payment is applied once",
        "# @boundedContext orders",
        "# @tag critical",
        "def checkout():",
        "    pass",
        "",
        "# @risk detached-marker",
        "",
        "class Receipt:",
        "    pass",
        "",
        "\"\"\"@contract not-a-comment\"\"\"",
        "def helper():",
        "    pass",
        "",
      ].join("\n"),
    });

    expect(result.symbols.map(({ name, markers }) => ({ name, markers }))).toEqual([
      {
        name: "checkout",
        markers: [
          { tag: "capability", slug: "order-checkout" },
          { tag: "invariant", slug: "paid-once", statement: "payment is applied once" },
          { tag: "boundedContext", slug: "orders" },
          { tag: "tag", slug: "critical" },
        ],
      },
      { name: "Receipt", markers: [] },
      { name: "helper", markers: [] },
    ]);
  });

  it("supports Python 3.12 type-parameter syntax and tab-indented adjacent markers", () => {
    const result = extract({
      "modern.py": [
        "class Box[T]:",
        "\t# @contract box-read",
        "\tdef read[U](self, fallback: U) -> T | U:",
        "\t\treturn fallback",
        "",
      ].join("\n"),
    });

    expect(result.symbols.map(({ name, kind, markers }) => ({ name, kind, markers }))).toEqual([
      { name: "Box", kind: "class", markers: [] },
      {
        name: "read",
        kind: "function",
        markers: [{ tag: "contract", slug: "box-read" }],
      },
    ]);
    expect(result.limitations).toEqual([]);
  });

  it("uses UTF-16 offsets while preserving precise 1-based lines and columns after astral Unicode", () => {
    const source = [
      "banner = \"🐍\"",
      "# @contract unicode-safe",
      "def parse_🐍():",
      "    return banner",
      "",
    ].join("\n");
    const result = extract({ "unicode.py": source });
    const symbol = result.symbols[0];

    expect(symbol?.name).toBe("parse_🐍");
    expect(symbol?.range).toEqual({
      startOffset: source.indexOf("def parse_🐍"),
      endOffset: source.indexOf("    return banner") + "    return banner".length,
      startLine: 3,
      startColumn: 1,
      endLine: 4,
      endColumn: 18,
    });
    expect(source.slice(symbol?.range.startOffset, symbol?.range.endOffset)).toBe(
      "def parse_🐍():\n    return banner",
    );
  });

  it("returns identical canonical output for every input permutation", () => {
    const files = [
      { relPath: "z.py", source: "def zed():\n    pass\n" },
      { relPath: "a.py", source: "from .b import value\nclass Alpha:\n    pass\n" },
      { relPath: "b.py", source: "value = 1\n" },
    ];

    const forward = extractPython(files);
    const reverse = extractPython([...files].reverse());
    const rotated = extractPython([files[1]!, files[2]!, files[0]!]);

    expect(reverse).toEqual(forward);
    expect(rotated).toEqual(forward);
  });

  it("reports unsupported or dynamic constructs and never emits inferred calls/contracts/tests", () => {
    const result = extract({
      "dynamic.py": [
        "from pkg import *",
        "module = __import__(name)",
        "loaded = importlib.import_module(name)",
        "sys.path.append(extra)",
        "def broken(",
        "",
      ].join("\n"),
    });

    expect(result.limitations.map((item) => item.kind)).toEqual([
      "star-import",
      "dynamic-import",
      "dynamic-import",
      "sys-path-mutation",
      "parse-error",
    ]);
    expect(result.imports).toEqual([
      {
        kind: "from",
        fromRelPath: "dynamic.py",
        module: "pkg",
        relativeLevel: 0,
        names: [{ name: "*" }],
        range: expect.objectContaining({ startLine: 1, endLine: 1 }),
      },
    ]);
    expect(result).not.toHaveProperty("calls");
    expect(result).not.toHaveProperty("contracts");
    expect(result).not.toHaveProperty("tests");
  });

  it("keeps aliased and exec-driven import resolution explicitly incomplete", () => {
    const result = extract({
      "aliases.py": [
        "import importlib as il",
        "from importlib import import_module as load",
        "import sys as runtime",
        "from sys import path as search_path",
        "first = il.import_module(name)",
        "second = load(other_name)",
        "runtime.path.insert(0, extra)",
        "search_path.append(extra)",
        "exec(\"import hidden\")",
        "",
      ].join("\n"),
    });

    expect(result.limitations.map((item) => item.kind)).toEqual([
      "dynamic-import",
      "dynamic-import",
      "sys-path-mutation",
      "sys-path-mutation",
      "dynamic-import",
    ]);
    expect(result.limitations.map((item) => item.range.startLine)).toEqual([5, 6, 7, 8, 9]);
    expect(result).not.toHaveProperty("calls");
  });
});
