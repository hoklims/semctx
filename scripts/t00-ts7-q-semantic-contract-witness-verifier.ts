import { createHash } from "node:crypto";
import { record } from "./t00-ts7-q-semantic-core";
import type { ContractWitness, ExpectedHelperResult, NativeExpectation, NativeIdentitySelector, NativeNodeSelector, WitnessVariant } from "./t00-ts7-q-semantic-contract-witness-types";

const records = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(record) : [];

type Fact = Record<string, unknown>;
type Cursor = { kind: "node" | "type" | "symbol" | "signature"; fact: Fact };
const absolute = (path: string): string => path.startsWith("/") ? path : `/project/${path}`;
const validId = (value: unknown): value is string | number => typeof value === "string" && value.length > 0 || typeof value === "number" && Number.isSafeInteger(value);
const factId = (value: unknown): unknown => typeof value === "string" || typeof value === "number" ? value : record(value)["id"];

function matcherContext(oracle: unknown, checkerFile: string, sourcePath = checkerFile) {
  const captured = record(oracle);
  const file = records(captured["files"]).find(entry => entry["path"] === checkerFile) ?? {};
  const graph = record(file["factsGraph"]);
  const sourceTexts = new Map<string, string>();
  for (const source of [...records(captured["files"]), ...records(captured["sourceFiles"])]) {
    const path = source["path"];
    const root = records(source["nodes"]).find(node => node["kind"] === "SourceFile" && node["start"] === 0);
    const text = source["text"] ?? root?.["text"];
    if (typeof path === "string" && typeof text === "string") sourceTexts.set(path, text);
  }
  const tables = Object.fromEntries(["nodes", "types", "symbols", "signatures"].map(table => [table, new Map(records(graph[table]).map(fact => [fact["id"], fact]))])) as Record<string, Map<unknown, Fact>>;
  const lookup = (kind: Cursor["kind"], value: unknown): Cursor | undefined => {
    if (value === undefined || value === null) return undefined;
    const reference = record(value);
    const fact = tables[`${kind}s`]?.get(factId(value)) ?? (typeof value === "object" ? reference : undefined);
    if (fact === undefined) return undefined;
    return { kind, fact: { ...record(reference["anchor"]), ...reference, ...fact } };
  };
  const nativeText = (node: Fact): string | undefined => {
    const path = node["path"] ?? checkerFile;
    const text = typeof path === "string" ? sourceTexts.get(path) : undefined;
    const start = node["start"], end = node["end"];
    if (text !== undefined && typeof start === "number" && typeof end === "number" && Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start) {
      const bytes = Buffer.from(text);
      if (end > bytes.length) return undefined;
      const prefix = bytes.subarray(0, start).toString("utf8"), value = bytes.subarray(start, end).toString("utf8");
      return Buffer.byteLength(prefix) === start && Buffer.byteLength(value) === end - start ? value : undefined;
    }
    return typeof node["text"] === "string" ? node["text"] : undefined;
  };
  const nodes = (): Fact[] => {
    const values: Fact[] = [...records(file["nodes"]).map(node => ({ path: checkerFile, ...node })), ...records(graph["nodes"])];
    const unique = new Map<string, Fact>();
    values.forEach((node, index) => {
      const coordinates = typeof node["start"] === "number" && typeof node["end"] === "number";
      const key = coordinates ? `${String(node["path"])}:${String(node["kind"])}:${String(node["start"])}:${String(node["end"])}` : `unbound:${index}`;
      unique.set(key, { ...unique.get(key), ...node });
    });
    return [...unique.values()];
  };
  const selectAll = (selector: NativeNodeSelector): Cursor[] => {
    const path = absolute(selector.sourcePath ?? sourcePath);
    return nodes().filter(node => node["path"] === path && nativeText(node) === selector.nodeText
      && (selector.syntaxKind === undefined || node["kind"] === selector.syntaxKind)
      && (selector.nativeByteStart === undefined || node["start"] === selector.nativeByteStart)
      && (selector.nativeByteEnd === undefined || node["end"] === selector.nativeByteEnd)).map(fact => ({ kind: "node", fact }));
  };
  const select = (selector: NativeNodeSelector): Cursor | undefined => {
    const matches = selectAll(selector);
    return matches.length === 1 ? matches[0] : undefined;
  };
  const capturedQuery = (operation: string, fact: Fact, location?: Fact): unknown => {
    if (fact["route"] === undefined) return undefined;
    const payload = { file: checkerFile, route: fact["route"], operation, ...(location === undefined ? {} : { location: location["anchor"] ?? { path: location["path"], kind: location["kind"], start: location["start"], end: location["end"] } }) };
    const id = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const result = records(graph["queryResults"]).find(entry => entry["id"] === id);
    return result?.["kind"] === (operation === "symbolType" ? "type" : "symbol") ? result["value"] : undefined;
  };
  const symbolType = (symbol: Fact, location: Fact): Cursor | undefined => {
    const anchor = record(location["anchor"] ?? location);
    const matches = records(graph["symbolTypes"]).filter(entry => entry["symbolId"] === symbol["id"]
      && ["path", "kind", "start", "end"].every(key => record(entry["location"])[key] === anchor[key]));
    const ids = new Set(matches.map(entry => entry["typeId"]));
    if (ids.size > 1) return undefined;
    return lookup("type", ids.size === 1 ? [...ids][0] : capturedQuery("symbolType", symbol, location));
  };
  const identityFromNode = (selector: NativeIdentitySelector, selected: Cursor): Cursor | undefined => {
    let cursor: Cursor | undefined = selected;
    const field = selector.target === "type" ? "type" : selector.target === "shorthandValueSymbol" ? "shorthandValueSymbol" : "symbol";
    cursor = lookup(selector.target === "type" ? "type" : "symbol", cursor.fact[`${field}Id`] ?? cursor.fact[field]);
    if (selector.target === "aliasedSymbol") cursor = cursor === undefined ? undefined : lookup("symbol", cursor.fact["aliasTarget"]);
    let signatureDeclaration: Fact | undefined;
    for (const step of selector.steps ?? []) {
      if (cursor === undefined) return undefined;
      const fact = cursor.fact;
      if ("index" in step && (!Number.isSafeInteger(step.index) || step.index < 0)) return undefined;
      switch (step.op) {
        case "callSignature": case "constructSignature": {
          const field = step.op === "callSignature" ? "callSignatures" : "constructSignatures";
          cursor = lookup("signature", Array.isArray(fact[field]) ? fact[field][step.index] : undefined);
          signatureDeclaration = cursor === undefined ? undefined : lookup("node", cursor.fact["declaration"])?.fact;
          break;
        }
        case "parameter": cursor = lookup("symbol", Array.isArray(fact["parameters"]) ? fact["parameters"][step.index] : undefined); break;
        case "union": case "intersection": {
          const parts = fact[`${step.op}Types`];
          cursor = lookup("type", Array.isArray(parts) ? parts[step.index] : undefined);
          break;
        }
        case "declaration": cursor = lookup("node", Array.isArray(fact["declarations"]) ? fact["declarations"][step.index] : step.index === 0 ? fact["declaration"] : undefined); break;
        case "symbol": cursor = lookup("symbol", fact["symbolId"] ?? fact["symbol"]); break;
        case "type": cursor = cursor.kind === "node" ? lookup("type", fact["typeId"] ?? fact["type"]) : undefined; break;
        case "shorthandValueSymbol": cursor = lookup("symbol", fact["shorthandValueSymbolId"] ?? fact["shorthandValueSymbol"]); break;
        case "aliasTarget": cursor = lookup("symbol", fact["aliasTarget"]); break;
        case "numberIndexType": case "baseConstraint": case "returnType": cursor = lookup("type", fact[step.op]); break;
        case "symbolType": {
          const location = step.location === "signatureDeclaration" ? signatureDeclaration : select(step.location)?.fact;
          cursor = location === undefined ? undefined : symbolType(fact, location);
          break;
        }
        case "property": {
          const matches = records(graph["propertyLookups"]).filter(entry => entry["typeId"] === fact["id"] && entry["name"] === step.name);
          const ids = new Set(matches.map(entry => entry["symbolId"]));
          if (ids.size > 1) return undefined;
          const route = record(fact["route"]);
          const queried = route["anchor"] === undefined || !Array.isArray(route["steps"]) ? undefined : capturedQuery("resolve", { route: { ...route, steps: [...(route["steps"] as unknown[]), { op: "property", name: step.name }] } });
          cursor = lookup("symbol", ids.size === 1 ? [...ids][0] : queried);
          break;
        }
      }
    }
    return cursor;
  };
  const identity = (selector: NativeIdentitySelector): Cursor | undefined => {
    const candidates = selectAll(selector).map(candidate => identityFromNode(selector, candidate));
    if (candidates.length === 0 || candidates.some(candidate => !validId(candidate?.fact["id"]))) return undefined;
    const identities = new Set(candidates.map(candidate => `${candidate!.kind}:${String(candidate!.fact["id"])}`));
    return identities.size === 1 ? candidates[0] : undefined;
  };
  const descriptorText = (value: Fact): string | undefined => {
    const source = sourceTexts.get(String(value["path"]));
    if (source === undefined) return typeof value["text"] === "string" ? value["text"] : undefined;
    const start = value["start"], end = value["end"];
    if (typeof start !== "number" || typeof end !== "number" || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > source.length) return undefined;
    if (typeof value["nativeByteStart"] === "number" && Buffer.byteLength(source.slice(0, start)) !== value["nativeByteStart"]) return undefined;
    if (typeof value["nativeByteEnd"] === "number" && Buffer.byteLength(source.slice(0, end)) !== value["nativeByteEnd"]) return undefined;
    return source.slice(start, end);
  };
  const declarationOrigin = (value: unknown): boolean | undefined => {
    const declaration = lookup("node", value)?.fact;
    if (declaration === undefined) return undefined;
    if (typeof declaration["defaultLibrary"] === "boolean") return declaration["defaultLibrary"];
    const file = [...records(captured["sourceFiles"]), ...records(captured["files"])].find(file => file["path"] === declaration["path"]);
    return typeof file?.["defaultLibrary"] === "boolean" ? file["defaultLibrary"] : undefined;
  };
  return { checkerFile, sourcePath, lookup, select, selectAll, identity, descriptorText, declarationOrigin, nodes, nativeText, constants: record(record(captured["compilerConstants"])["typeFlags"]) };
}
type MatchContext = ReturnType<typeof matcherContext>;

function resultMatches(value: unknown, expected: ExpectedHelperResult, context: MatchContext, boundByParent = false): boolean {
  const actual = record(value);
  if (actual["kind"] === "unavailable") return false;
  if (expected.kind === "boolean" || expected.kind === "string" || expected.kind === "number") return actual["kind"] === expected.kind && actual["value"] === expected.value;
  if (expected.kind === "undefined") return actual["kind"] === "undefined";
  if (expected.kind === "node") {
    if (actual["kind"] !== "node" || actual["syntaxKind"] !== expected.syntaxKind || typeof actual["path"] !== "string" || !Number.isSafeInteger(actual["start"]) || !Number.isSafeInteger(actual["end"]) || Number(actual["start"]) < 0 || Number(actual["end"]) < Number(actual["start"])) return false;
    if (expected.text !== undefined && context.descriptorText(actual) !== expected.text) return false;
    for (const field of ["path", "start", "end", "nativeByteStart", "nativeByteEnd", "defaultLibrary", "rest"] as const) {
      if (expected[field] !== undefined && actual[field] !== (field === "path" ? absolute(expected.path!) : expected[field])) return false;
    }
    return true;
  }
  if (expected.kind === "object") return actual["kind"] === "object" && actual["properties"] !== null && typeof actual["properties"] === "object" && !Array.isArray(actual["properties"]) && Object.entries(expected.properties).every(([name, value]) => resultMatches(record(actual["properties"])[name], value, context));
  if (expected.kind === "array") return actual["kind"] === "array" && Array.isArray(actual["values"]) && actual["values"].length === expected.values.length
    && expected.values.every((value, index) => resultMatches((actual["values"] as unknown[])[index], value, context));
  if (expected.kind === "declarations") {
    if (actual["kind"] !== "array" || !Array.isArray(actual["values"])) return false;
    const declarations = records(actual["values"]);
    return declarations.length === expected.syntaxKinds.length && declarations.every(entry => entry["kind"] === "node")
      && JSON.stringify(declarations.map(entry => entry["syntaxKind"]).sort()) === JSON.stringify([...expected.syntaxKinds].sort())
      && (expected.declarationPaths === undefined || JSON.stringify(declarations.map(entry => entry["path"]).sort()) === JSON.stringify(expected.declarationPaths.map(absolute).sort()));
  }
  if (expected.native === undefined && !boundByParent) return false;
  if (actual["kind"] !== expected.kind || actual["checkerFile"] !== context.checkerFile || actual["nativeId"] === undefined) return false;
  const native = context.lookup(expected.kind, actual["nativeId"]);
  if (native === undefined) return false;
  if (expected.native !== undefined) {
    const selected = context.identity(expected.native);
    if (selected?.kind !== expected.kind || selected.fact["id"] !== actual["nativeId"]) return false;
  }
  const fact = native.fact;
  if (expected.kind === "symbol") {
    if (expected.name !== undefined && (actual["name"] !== expected.name || fact["name"] !== expected.name)) return false;
    if (expected.defaultLibrary !== undefined && (!Array.isArray(fact["declarations"]) || fact["declarations"].length === 0 || !fact["declarations"].every(value => context.declarationOrigin(value) === expected.defaultLibrary))) return false;
    if (expected.declarations !== undefined) {
      const observed = records(actual["declarations"]), declarations = Array.isArray(fact["declarations"]) ? fact["declarations"] : undefined;
      if (declarations === undefined || observed.length !== declarations.length || observed.length !== expected.declarations.length) return false;
      if (!expected.declarations.every((expected, index) => {
        const node = context.lookup("node", declarations[index])?.fact;
        return node !== undefined && observed[index]?.["path"] === node["path"] && observed[index]?.["nativeByteStart"] === node["start"] && observed[index]?.["nativeByteEnd"] === node["end"] && resultMatches(observed[index], expected, context);
      })) return false;
    }
    return true;
  }
  for (const name of expected.flagsNames ?? []) {
    const mask = context.constants[name];
    if (typeof mask !== "number" || mask === 0 || typeof fact["flagsBits"] !== "number" || (fact["flagsBits"] & mask) === 0 || !Array.isArray(actual["flagsNames"]) || !actual["flagsNames"].includes(name)) return false;
  }
  for (const [field, count, predicate] of [["callSignatures", "callSignatureCount", "callable"], ["constructSignatures", "constructSignatureCount", "constructible"]] as const) {
    if (expected[count] === undefined && expected[predicate] === undefined) continue;
    const values = fact[field];
    const observed = Array.isArray(values) ? values.length : typeof fact[count] === "number" ? fact[count] : undefined;
    if (typeof observed !== "number" || actual[count] !== observed || (expected[count] !== undefined && observed !== expected[count]) || (expected[predicate] !== undefined && (observed > 0) !== expected[predicate])) return false;
  }
  for (const [field, predicate] of [["unionTypes", "union"], ["intersectionTypes", "intersection"]] as const) {
    if (expected[field] === undefined && expected[predicate] === undefined) continue;
    const parts = fact[field];
    if (!Array.isArray(parts)) return false;
    if (expected[predicate] !== undefined && (parts.length > 0) !== expected[predicate]) return false;
    const expectedParts = expected[field];
    if (expectedParts !== undefined && (!Array.isArray(actual[field]) || parts.length !== expectedParts.length || actual[field].length !== parts.length
      || !expectedParts.every((value, index) => record((actual[field] as unknown[])[index])["nativeId"] === factId(parts[index]) && resultMatches((actual[field] as unknown[])[index], value, context, true)))) return false;
  }
  if (expected.baseConstraintPresent !== undefined && (!("baseConstraint" in fact) || actual["baseConstraintPresent"] !== expected.baseConstraintPresent || (fact["baseConstraint"] !== null) !== expected.baseConstraintPresent)) return false;
  for (const [field, kind] of [["symbol", "symbol"], ["baseConstraint", "type"]] as const) {
    if (expected[field] === undefined) continue;
    if (!(field in fact)) return false;
    const descriptor = record(actual[field]);
    if (fact[field] === null ? descriptor["kind"] !== "undefined" : descriptor["kind"] !== kind || descriptor["nativeId"] !== factId(fact[field])) return false;
    if (!resultMatches(descriptor, expected[field], context, true)) return false;
  }
  return true;
}

function nativeMatches(expectation: NativeExpectation, helpers: Fact[], context: MatchContext, files: Record<string, string>): boolean {
  if (expectation.kind === "helper-return") return helpers.some(helper => {
    const arguments_ = records(helper["arguments"]), argument = arguments_[0];
    if (helper["index"] !== expectation.consumerIndex || argument === undefined || (expectation.argumentText === undefined && expectation.argument === undefined)) return false;
    if (expectation.argumentText !== undefined && context.descriptorText(argument) !== expectation.argumentText) return false;
    if ((expectation.argumentText !== undefined || expectation.argumentPath !== undefined || expectation.argument?.kind === "node") && argument["kind"] === "node" && argument["path"] !== absolute(expectation.argumentPath ?? (expectation.argument?.kind === "node" ? expectation.argument.path : undefined) ?? context.sourcePath)) return false;
    if (expectation.argumentStart !== undefined && argument["start"] !== expectation.argumentStart) return false;
    if (expectation.argumentEnd !== undefined && argument["end"] !== expectation.argumentEnd) return false;
    if (expectation.argument !== undefined && !resultMatches(argument, expectation.argument, context)) return false;
    if (expectation.argumentConstraints?.some(constraint => !Number.isSafeInteger(constraint.position) || constraint.position < 0 || !resultMatches(arguments_[constraint.position], constraint.expected, context))) return false;
    return resultMatches(helper["value"], expectation.expected, context);
  });
  if (expectation.kind === "helper-descendants-absent") {
    const parent = context.select(expectation.parent)?.fact;
    if (parent === undefined || (parent["isTypeNode"] !== true && parent["kind"] !== "InterfaceDeclaration") || typeof parent["start"] !== "number" || typeof parent["end"] !== "number") return false;
    const calls = helpers.filter(helper => helper["index"] === expectation.consumerIndex).map(helper => records(helper["arguments"])[0]);
    if (calls.some(argument => argument?.["kind"] !== "node" || typeof argument["path"] !== "string" || typeof argument["nativeByteStart"] !== "number" || typeof argument["nativeByteEnd"] !== "number")) return false;
    const local = calls.filter(argument => argument!["path"] === parent["path"]);
    if (!local.some(argument => argument!["syntaxKind"] === parent["kind"] && argument!["nativeByteStart"] === parent["start"] && argument!["nativeByteEnd"] === parent["end"])) return false;
    const start = parent["start"], end = parent["end"];
    return !local.some(argument => Number(argument!["nativeByteStart"]) >= start && Number(argument!["nativeByteEnd"]) <= end
      && (argument!["nativeByteStart"] !== start || argument!["nativeByteEnd"] !== end));
  }
  if (expectation.kind === "syntax") return context.nodes().filter(node => node["path"] === context.sourcePath && node["kind"] === expectation.syntaxKind
    && (expectation.text === undefined || context.nativeText(node) === expectation.text)
    && (expectation.nativeByteStart === undefined || node["start"] === expectation.nativeByteStart)
    && (expectation.nativeByteEnd === undefined || node["end"] === expectation.nativeByteEnd)).length >= expectation.minimumCount;
  const selected = context.selectAll(expectation);
  if (selected.length === 0) return false;
  if (expectation.kind === "symbol-origin") {
    const symbols = selected.map(({ fact: node }) => {
      const value = "symbolId" in node ? node["symbolId"] : node["symbol"];
      if (value === undefined || value === null) return value;
      let symbol = context.lookup("symbol", value)?.fact;
      if (symbol?.["aliasTarget"] !== undefined && symbol["aliasTarget"] !== null) symbol = context.lookup("symbol", symbol["aliasTarget"])?.fact;
      else if (node["aliasedSymbol"] !== undefined) symbol = context.lookup("symbol", node["aliasedSymbol"])?.fact;
      return symbol;
    });
    if (expectation.origin === "absent") return symbols.every(symbol => symbol === null);
    if (symbols.some(symbol => symbol === undefined || symbol === null)) return false;
    if (symbols.length > 1 && (symbols.some(symbol => !validId(symbol!["id"])) || new Set(symbols.map(symbol => symbol!["id"])).size !== 1)) return false;
    const origins = symbols[0]?.["declarations"];
    return Array.isArray(origins) && origins.length > 0 && origins.every(origin => expectation.origin === "default-library"
      ? context.declarationOrigin(origin) === true
      : context.declarationOrigin(origin) === false && Object.keys(files).some(path => context.lookup("node", origin)?.fact["path"] === absolute(path)));
  }
  const types = selected.map(({ fact: node }) => context.lookup("type", node["typeId"] ?? node["type"])?.fact);
  if (types.some(type => type === undefined)) return false;
  if (types.length > 1 && (types.some(type => !validId(type!["id"])) || new Set(types.map(type => type!["id"])).size !== 1)) return false;
  const type = types[0]!;
  for (const [option, signatures, count] of [["callable", "callSignatures", "callSignatureCount"], ["constructible", "constructSignatures", "constructSignatureCount"]] as const) {
    if (expectation[option] === undefined) continue;
    const observed = Array.isArray(type[signatures]) ? type[signatures].length : type[count];
    if (typeof observed !== "number" || (observed > 0) !== expectation[option]) return false;
  }
  for (const [option, parts] of [["union", "unionTypes"], ["intersection", "intersectionTypes"]] as const) {
    if (expectation[option] !== undefined && (!Array.isArray(type[parts]) || (type[parts].length > 0) !== expectation[option])) return false;
  }
  return Object.keys(type).length > 0;
}

export function verifyContractWitness(
  oracle: unknown,
  projection: unknown,
  witness: ContractWitness,
  label: WitnessVariant,
  path: string,
): { passed: boolean; gaps: string[] } {
  const observation = record(projection);
  const file = records(record(oracle)["files"]).find(entry => entry["path"] === path || entry["path"] === `/project/${path}`);
  const gaps: string[] = [];
  if (witness.requiredAlternatives.length === 0 || new Set(witness.requiredAlternatives).size !== witness.requiredAlternatives.length) gaps.push("WITNESS_ALTERNATIVE_INVENTORY_INVALID");
  for (const alternative of witness.requiredAlternatives) {
    if (!witness.nativeExpectations.some(expectation => expectation.alternatives?.includes(alternative))) gaps.push(`WITNESS_ALTERNATIVE_ASSERTION_MISSING:${alternative}`);
  }
  const variantExpectations = witness.nativeExpectations.filter(expectation => expectation.variant === label);
  if (variantExpectations.length === 0) gaps.push(`WITNESS_VARIANT_ASSERTION_MISSING:${label}`);
  if (witness.nativeExpectations.some(expectation => expectation.alternatives?.some(alternative => !witness.requiredAlternatives.includes(alternative)))) gaps.push("WITNESS_UNDECLARED_ALTERNATIVE_ASSERTION");
  if (file === undefined || typeof file["path"] !== "string" || !Array.isArray(file["nodes"]) || file["nodes"].length === 0) gaps.push("WITNESS_NATIVE_FILE_MISSING");
  if (observation["status"] !== "projected" || !Array.isArray(observation["gaps"]) || observation["gaps"].length !== 0) gaps.push("WITNESS_PROJECTION_INCOMPLETE");
  const helpers = records(observation["helperResults"]);
  if (!helpers.some(helper => helper["index"] === witness.index && Array.isArray(helper["arguments"]) && typeof record(helper["value"])["kind"] === "string")) gaps.push("WITNESS_TARGET_HELPER_NOT_EXECUTED");
  if (file !== undefined && typeof file["path"] === "string") {
    for (const [position, expectation] of witness.nativeExpectations.entries()) {
      if (expectation.variant !== label) continue;
      const expectedPath = expectation.sourcePath === undefined ? file["path"] : expectation.sourcePath.startsWith("/") ? expectation.sourcePath : `/project/${expectation.sourcePath}`;
      const expectedFile = records(record(oracle)["files"]).find(entry => entry["path"] === expectedPath);
      if (expectedFile === undefined) { gaps.push(`WITNESS_EXPECTATION_SOURCE_MISSING:${position}:${expectedPath}`); continue; }
      if (expectation.kind === "syntax" && (!Number.isSafeInteger(expectation.minimumCount) || expectation.minimumCount < 1)) gaps.push(`WITNESS_SYNTAX_EXPECTATION_INVALID:${position}`);
      if (!nativeMatches(expectation, helpers, matcherContext(oracle, expectation.kind === "helper-return" || expectation.kind === "helper-descendants-absent" ? file["path"] : expectedPath, expectedPath), label === "activate" ? witness.files : witness.controlFiles)) gaps.push(`WITNESS_EXPECTATION_UNSATISFIED:${position}:${expectation.kind}`);
    }
  }
  return { passed: gaps.length === 0, gaps };
}
