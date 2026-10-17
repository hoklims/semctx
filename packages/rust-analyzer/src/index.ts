import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser, type Node } from "web-tree-sitter";

import type { RustSource, RustRange, RustMarker, RustSymbol, RustExtraction } from "./model";
export type { RustSource, RustRange, RustMarker, RustSymbol, RustLimitation, RustExtraction } from "./model";
export { extractRustSync } from "./worker-client";
export { rustToolchainIdentity } from "./navigation";

let language: Promise<Language> | undefined;

function rustLanguage(): Promise<Language> {
  language ??= (async () => {
    const packaged = join(import.meta.dir, "rust-parser");
    const runtime = existsSync(join(packaged, "web-tree-sitter.wasm"))
      ? join(packaged, "web-tree-sitter.wasm")
      : fileURLToPath(import.meta.resolve("web-tree-sitter/web-tree-sitter.wasm"));
    await Parser.init({ locateFile: () => runtime });
    return await Language.load(existsSync(join(packaged, "tree-sitter-rust.wasm"))
      ? join(packaged, "tree-sitter-rust.wasm")
      : join(dirname(import.meta.dir), "vendor", "tree-sitter-rust.wasm"));
  })();
  return language;
}

function range(node: Node): RustRange {
  return {
    startOffset: node.startIndex,
    endOffset: node.endIndex,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    startColumn: node.startPosition.column + 1,
    endColumn: node.endPosition.column + 1,
  };
}

function attributes(node: Node): { text: string; range: RustRange }[] {
  const result: { text: string; range: RustRange }[] = [];
  for (let previous = node.previousNamedSibling; previous !== null; previous = previous.previousNamedSibling) {
    if (!["attribute_item", "line_comment", "block_comment"].includes(previous.type)) break;
    result.unshift({ text: previous.text, range: range(previous) });
  }
  return result;
}

function markers(attrs: readonly { text: string; range: RustRange }[]): RustMarker[] {
  const documentation = attrs.flatMap((attribute) => {
    if (/^\/\/\//.test(attribute.text) && !/^\/\/\/\//.test(attribute.text)) return [{ text: attribute.text.slice(3), range: attribute.range }];
    if (/^\/\*\*/.test(attribute.text) && !/^\/\*\*\*/.test(attribute.text)) return [{ text: attribute.text.slice(3, -2), range: attribute.range }];
    const value = /^#\[\s*doc\s*=\s*"([^"\\]*)"\s*\]$/u.exec(attribute.text)?.[1];
    return value === undefined ? [] : [{ text: value, range: attribute.range }];
  });
  const result: RustMarker[] = [];
  for (const document of documentation) {
    for (const match of document.text.matchAll(/@(capability|invariant|contract|risk|boundedcontext|tag)[ \t]+([A-Za-z0-9][A-Za-z0-9_-]*)[ \t]*(?::[ \t]*([^\r\n]+))?/gi)) {
      const rawTag = match[1]!.toLowerCase();
      const tag = rawTag === "boundedcontext" ? "boundedContext" : rawTag as RustMarker["tag"];
      const statement = match[3]?.trim();
      result.push({ tag, slug: match[2]!, ...(statement ? { statement } : {}), range: document.range });
    }
  }
  return result;
}

function declaration(node: Node, file: RustSource, scope: string[]): RustSymbol | undefined {
  const nameNode = node.childForFieldName("name");
  const attributeRanges = attributes(node);
  const attrs = attributeRanges.map((attribute) => attribute.text);
  let name = nameNode?.text;
  let kind: RustSymbol["kind"];
  switch (node.type) {
    case "function_item":
    case "function_signature_item":
      kind = attrs.some((attribute) => /^#\[\s*test\s*\]$/.test(attribute)) ? "test" : "function";
      break;
    case "struct_item":
    case "trait_item":
    case "type_item":
    case "union_item": kind = "type"; break;
    case "enum_item": kind = "enum"; break;
    case "mod_item": kind = "module"; break;
    case "impl_item": {
      const trait = node.childForFieldName("trait")?.text;
      const target = node.childForFieldName("type")?.text;
      name = trait === undefined ? `impl ${target}` : `impl ${trait} for ${target}`;
      kind = "symbol";
      break;
    }
    default: return undefined;
  }
  if (name === undefined) return undefined;
  return {
    relPath: file.relPath, name, kind, rustKind: node.type, scope,
    visibility: node.namedChildren.find((child) => child.type === "visibility_modifier")?.text ?? "private",
    range: range(node), nameRange: range(nameNode ?? node), attributes: attrs, markers: markers(attributeRanges),
  };
}

function collect(node: Node, file: RustSource, scope: string[], result: RustExtraction): void {
  const symbol = declaration(node, file, scope);
  if (symbol !== undefined) result.symbols.push(symbol);
  const kind = node.type === "use_wildcard" ? "glob-import"
    : node.type === "macro_invocation" || node.type === "macro_definition" ? "macro-expansion"
    : node.type === "attribute_item" && /^#\[\s*cfg(?:_attr)?\s*\(/.test(node.text) ? "conditional-source"
    : undefined;
  if (kind !== undefined) result.limitations.push({ relPath: file.relPath, kind, range: range(node) });
  if (node.type === "use_declaration") {
    const argument = node.childForFieldName("argument");
    if (argument !== null) for (const target of importTargets(argument)) {
      result.queries.push({ relPath: file.relPath, kind: "import", scope, range: range(node), target: range(target) });
    }
  }
  if (node.type === "call_expression") {
    const expression = node.childForFieldName("function");
    const target = expression === null ? null : callableName(expression);
    if (target !== null) result.queries.push({ relPath: file.relPath, kind: "call", scope, range: range(node), target: range(target) });
  }
  const nestedScope = symbol === undefined ? scope : [...scope,
    node.type === "trait_item" ? `trait ${symbol.name}` : symbol.name];
  for (const child of node.namedChildren) collect(child, file, nestedScope, result);
}

function callableName(node: Node): Node | null {
  if (["identifier", "type_identifier", "field_identifier"].includes(node.type)) return node;
  const child = node.childForFieldName("function") ?? node.childForFieldName("name") ?? node.childForFieldName("field");
  return child === null ? null : callableName(child);
}

function importTargets(node: Node): Node[] {
  if (node.type === "use_as_clause") {
    const path = node.childForFieldName("path");
    return path === null ? [] : importTargets(path);
  }
  if (node.type === "use_list") return node.namedChildren.flatMap(importTargets);
  if (node.type === "scoped_use_list") {
    const list = node.childForFieldName("list");
    return list === null ? [] : importTargets(list);
  }
  if (node.type === "use_wildcard") return [];
  const name = callableName(node);
  return name === null ? [] : [name];
}

export async function extractRust(files: readonly RustSource[]): Promise<RustExtraction> {
  const seen = new Set<string>();
  for (const file of files) {
    if (file.relPath.length === 0 || /^[A-Za-z]:/.test(file.relPath) || file.relPath.includes("\\")
      || file.relPath.split("/").some((part) => part === "" || part === "." || part === "..")) {
      throw new Error("RUST_SOURCE_PATH_INVALID");
    }
    if (seen.has(file.relPath)) throw new Error("RUST_DUPLICATE_SOURCE");
    seen.add(file.relPath);
  }
  const rust = await rustLanguage();
  const parser = new Parser();
  parser.setLanguage(rust);
  const result: RustExtraction = { symbols: [], limitations: [], queries: [] };
  try {
    for (const file of [...files].sort((a, b) => a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0)) {
      const tree = parser.parse(file.source);
      if (tree === null) throw new Error("RUST_PARSE_CANCELLED");
      try {
        if (tree.rootNode.hasError) result.limitations.push({ relPath: file.relPath, kind: "parse-error", range: range(tree.rootNode) });
        collect(tree.rootNode, file, [], result);
      }
      finally { tree.delete(); }
    }
    return result;
  } finally { parser.delete(); }
}
