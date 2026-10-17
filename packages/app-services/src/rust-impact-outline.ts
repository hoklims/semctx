import type { ImpactFileOutline } from "@semantic-context/context-engine";
import { extractRustSync } from "@semantic-context/rust-analyzer";

export function rustImpactOutline(source: string, path: string): ImpactFileOutline {
  try {
    const extracted = extractRustSync([{ relPath: path, source }]);
    const topLevel = extracted.symbols.filter((symbol) => symbol.scope.length === 0);
    const production = (symbol: (typeof extracted.symbols)[number]): boolean => symbol.kind !== "test"
      && !symbol.attributes.some((attribute) => /^#\[\s*cfg(?:_attr)?\s*\(/.test(attribute));
    const exportedNames = new Set(topLevel.filter((symbol) => symbol.visibility === "pub" && production(symbol))
      .map((symbol) => symbol.name));
    for (const symbol of topLevel.filter((item) => item.rustKind === "impl_item" && production(item))) {
      if (extracted.symbols.some((method) => method.scope[0] === symbol.name && method.visibility === "pub" && production(method))) {
        exportedNames.add(symbol.name);
      }
    }
    return {
      statements: topLevel.map((symbol) => ({
        kind: symbol.kind,
        startLine: symbol.range.startLine,
        endLine: symbol.range.endLine,
        leadingStartLine: Math.min(symbol.range.startLine, ...symbol.markers.map((marker) => marker.range.startLine)),
        declaredNames: [symbol.name],
        referencedNames: [],
        executesOnLoad: false,
      })),
      exportedNames: [...exportedNames].sort(),
      hasSyntaxErrors: extracted.limitations.some((limitation) => limitation.kind === "parse-error"),
      markerLines: [...new Set(extracted.symbols.flatMap((symbol) => symbol.markers.map((marker) => marker.range.startLine)))].sort((a, b) => a - b),
      directiveLines: [...new Set(extracted.limitations.filter((limitation) => limitation.kind !== "parse-error")
        .map((limitation) => limitation.range.startLine))].sort((a, b) => a - b),
    };
  } catch {
    return { statements: [], exportedNames: [], hasSyntaxErrors: true };
  }
}
