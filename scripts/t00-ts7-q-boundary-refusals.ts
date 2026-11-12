import { isDeepStrictEqual } from "node:util";
import type { Context, Evidence, Execution, Json, Property } from "./t00-ts7-q-boundary-common";
import { outcome, prepare, descriptor, compareAdmission } from "./t00-ts7-q-boundary-admission";

const contract = "ADR 0035 accepted; frozen QRECEIPT-01, P23 and N23 semantic expectations in qualification/scenarios.json; TS7 contract";
const record = (value: unknown): Json => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const property = (name: string, expected: unknown, actual: unknown): Property => ({ name, expected, actual, pass: isDeepStrictEqual(expected, actual), oracle: contract });
const permitted = new Set(["fresh-valid", "dirty-known-only-working-tree"]);
export const receiptGuards = ["fresh-valid", "dirty-known-only-working-tree", "missing-freshness-seal", "invalid-binding", "incomplete-build", "check-changed", "stale", "dirty-other-reason", "sealed-facts-mismatch", "indexed-facts-mismatch", "sealed-input-mismatch", "indexed-input-mismatch", "expected-input-mismatch", "profile-mismatch", "root-mismatch", "forged-receipt-provenance", "post-receipt-graph-mutation", "post-receipt-capture-mutation", "missing-receipt", "request-mismatch", "artifact-mismatch"];

export function compareReceiptGuard(variant: string, result: Execution, expectedRoot: string): Property[] {
  if (!receiptGuards.includes(variant)) throw Error(`Unknown receipt guard ${variant}`);
  const available = permitted.has(variant), report = result.value;
  const consumed = (value: unknown): unknown => Array.isArray(value) ? value.map(record).map(subject => ({ path: subject.path, reasons: record(record(subject.moduleConfigurationObservations).retainedWithoutSource).reasons })) : value;
  const expectedSubjects = [{ path: "src/main.ts", reasons: [] }];
  return [
    property(`${variant}.observer.exit`, 0, result.exitCode),
    property(`${variant}.root.control`, expectedRoot, report.controlRoot),
    property(`${variant}.root.observed`, variant === "root-mismatch" ? "/foreign-root" : expectedRoot, report.observedRoot),
    property(`${variant}.root.restored`, expectedRoot, report.restoredRoot),
    property(`${variant}.receipt.issued`, true, report.received),
    property(`${variant}.control.available`, true, report.controlContextAvailable),
    property(`${variant}.control.consumed`, expectedSubjects, consumed(report.controlSubjects)),
    property(`${variant}.context.available`, available, report.contextAvailable),
    property(`${variant}.context.consumed`, available ? expectedSubjects : null, consumed(report.subjects)),
    property(`${variant}.context.reason`, true, available ? report.reason === null : typeof report.reason === "string" && report.reason.length > 0),
    property(`${variant}.restored.available`, true, report.restoredContextAvailable),
    property(`${variant}.restored.consumed`, expectedSubjects, consumed(report.restoredSubjects)),
    property(`${variant}.phase`, "revalidate_after_receipt", report.phase),
    property(`${variant}.globalAdmission`, false, report.globalAdmissionInferred),
  ];
}

export async function receiptGuardObservations(ctx: Context): Promise<{ properties: Property[]; evidence: Evidence[] }> {
  const properties: Property[] = [], evidence: Evidence[] = [];
  for (const [id, callback, admitted] of [["inline-call", "helper()", true], ["returned-helper", "helper", false], ["unknown-call", "unknown()", false], ["constant-result", "1", false]] as const) {
    const fixture = await prepare(ctx, `ownership-${id}`, {
      "src/main.ts": `import { register } from 'opaque'; function helper() { return 1; } export function main(${id === "unknown-call" ? "unknown: () => number" : ""}) { ${admitted ? "" : "helper(); "}return register(() => ${callback}); }`,
      "package.json": '{"dependencies":{"opaque":"1.0.0"}}',
    });
    const indexed = await ctx.run(`ownership-${id}-index`, "--batch", fixture.analysis, true);
    const analyzed = await ctx.run(`ownership-${id}-analysis`, "", fixture.analysis, true);
    const verified = await ctx.run(`ownership-${id}-verify`, "verify", descriptor(ctx, fixture, outcome(indexed)), true);
    properties.push(property(`${id}.index.success`, 0, indexed.exitCode), property(`${id}.analysis.success`, 0, analyzed.exitCode));
    properties.push(...compareAdmission(`ownership.${id}`, { status: admitted ? "admitted" : "rejected", coverage: [{ path: "src/main.ts", status: admitted ? "analyzed" : "unsupported" }] }, verified));
    const subject = list(analyzed.value.subjects).map(record).find(item => item.path === "src/main.ts");
    const ownership = record(subject?.opaqueCallbackOwnership);
    properties.push(property(`${id}.ownership.executed`, true, ownership.executed));
    properties.push(property(`${id}.calls.main-helper`, true, list(record(analyzed.value.raw_extraction).calls).map(record).some(call => call.callerRelPath === "src/main.ts" && call.callerSymbolPath === "main" && call.calleeRelPath === "src/main.ts" && call.calleeName === "helper")));
    for (const [phase, expected] of [["beforeAnalysis", true], ["afterAnalysis", !admitted], ["afterGraphEdgesRemoved", true]] as const) {
      properties.push(property(`${id}.${phase}.opaque`, expected, list(record(ownership[phase]).reasons).includes("SOURCE_OPAQUE_CALLBACK_UNSUPPORTED")));
    }
    evidence.push(...fixture.evidence, ...indexed.evidence, ...analyzed.evidence, ...verified.evidence);
    if (!admitted) continue;
    for (const claimedOwnership of [true, false]) {
      const claimedBatch = { ...indexed.value, producer_claimed_ownership: claimedOwnership };
      const claimedOutcome = outcome({ ...indexed, value: claimedBatch, stdout: JSON.stringify(claimedBatch) });
      for (const variant of receiptGuards) {
        const observed = await ctx.run(`receipt-guard-${variant}-claim-${claimedOwnership}`, "--observe-qualified-receipt", { analysis: fixture.analysis, indexedOutcome: claimedOutcome, variant }, true);
        properties.push(...compareReceiptGuard(variant, observed, fixture.root).map(item => ({ ...item, name: `producer-claim-${claimedOwnership}.${item.name}` })));
        evidence.push(...observed.evidence);
      }
    }
  }
  const anonymousFiles = {
    "default.mjs": "export default function () { function nested() { return 1; } return nested(); }",
    "caller.mjs": "import value from './default.mjs'; export function caller() { return value(); }",
  };
  const anonymous = await ctx.run("ownership-anonymous-nested", "", ctx.analysis(anonymousFiles), true);
  const extraction = record(anonymous.value.raw_extraction);
  const coordinates = list(extraction.calls).map(record).map(call => ({ caller: [call.callerRelPath, call.callerSymbolPath], callee: [call.calleeRelPath, call.calleeSymbolPath] })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  properties.push(property("anonymous-nested.exit", 0, anonymous.exitCode), property("anonymous-nested.calls", [
    { caller: ["caller.mjs", "caller"], callee: ["default.mjs", "default"] },
    { caller: ["default.mjs", "default"], callee: ["default.mjs", "default.nested"] },
  ], coordinates));
  properties.push(property("anonymous-nested.symbols", [
    { path: "caller.mjs", name: "caller", kind: "function", scope: [], exported: true },
    { path: "default.mjs", name: "default", kind: "function", scope: [], exported: true },
    { path: "default.mjs", name: "nested", kind: "function", scope: ["default"], exported: false },
  ], list(extraction.symbols).map(record).map(symbol => ({ path: symbol.relPath, name: symbol.name, kind: symbol.kind, scope: symbol.scope, exported: symbol.exported })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))));
  evidence.push(...anonymous.evidence);
  return { properties, evidence };
}
