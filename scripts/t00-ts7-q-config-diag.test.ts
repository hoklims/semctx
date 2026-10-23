import { describe, expect, test } from "bun:test";
import { compilerDiagnostics } from "./t00-ts7-q-config-cr";
import { assessConfigurationPair, compareConfigurationObservation, projectConfigurationObservation } from "./t00-ts7-q-config-diag";

describe("configuration diagnostic witness qualification", () => {
  test("accepts exact owning component reasons with a clean execution", () => {
    expect(compareConfigurationObservation({ executed: true, reasons: ["SOURCE_NAMED_CONFIGURATION_UNSUPPORTED"], unsupported: [] }, ["SOURCE_NAMED_CONFIGURATION_UNSUPPORTED"])).toBe(true);
  });

  test("an extra reason, unsupported operation or absent component fails the comparison", () => {
    expect(compareConfigurationObservation({ executed: true, reasons: ["SOURCE_NAMED_CONFIGURATION_UNSUPPORTED", "unexpected"], unsupported: [] }, ["SOURCE_NAMED_CONFIGURATION_UNSUPPORTED"])).toBe(false);
    expect(compareConfigurationObservation({ executed: true, reasons: [], unsupported: ["unobserved"] }, [])).toBe(false);
    expect(compareConfigurationObservation(undefined, [])).toBe(false);
    expect(compareConfigurationObservation({ executed: false, reasons: [], unsupported: [] }, [])).toBe(false);
  });

  test("flattens the real TS7 removed-baseUrl multiline diagnostic without dropping its suggestion", () => {
    expect(compilerDiagnostics(`tsconfig.json(1,1): error TS5102: Option 'baseUrl' has been removed. Please remove it from your configuration.\n  Use '"paths": {"*": ["./src/*"]}' instead.\n`)).toEqual([
      { code: 5102, message: `Option 'baseUrl' has been removed. Please remove it from your configuration. Use '"paths": {"*": ["./src/*"]}' instead.` },
    ]);
  });

  test("a malformed reason cannot disappear inside a semantic or runtime projection", () => {
    expect(compareConfigurationObservation(projectConfigurationObservation({ executed: true, reasons: [42], unsupported: [] }, ["SOURCE_"]), [])).toBe(false);
  });

  test("semantic composition excludes only the named configuration layer and retains unexpected semantic reasons", () => {
    const observed = { executed: true, reasons: ["SOURCE_CONFIGURATION_MODULE_UNSUPPORTED:CommonJS", "SOURCE_REFERENCE_PATH_UNSUPPORTED", "SOURCE_UNRESOLVED_CALLEE_UNSUPPORTED"], unsupported: [] };
    const projected = projectConfigurationObservation(observed, ["SOURCE_"], ["SOURCE_CONFIGURATION_"]);
    expect(compareConfigurationObservation(projected, ["SOURCE_REFERENCE_PATH_UNSUPPORTED"])).toBe(false);
    expect(compareConfigurationObservation(projected, ["SOURCE_REFERENCE_PATH_UNSUPPORTED", "SOURCE_UNRESOLVED_CALLEE_UNSUPPORTED"])).toBe(true);
  });

  test("a passing activation cannot qualify a missing control", () => {
    expect(assessConfigurationPair("named consumption", [{ role: "activation", pass: true, evidence: [] }]).status).toBe("not_qualified");
  });

  test("a mismatching or unbound control cannot close a property", () => {
    const bound = [{ path: "/evidence", sha256: "a".repeat(64), bytes: 1 }];
    expect(assessConfigurationPair("named consumption", [{ role: "activation", pass: true, evidence: bound }, { role: "control", pass: false, evidence: bound }]).status).toBe("fail");
    expect(assessConfigurationPair("named consumption", [{ role: "activation", pass: true, evidence: [] }, { role: "control", pass: true, evidence: [] }]).status).toBe("not_qualified");
  });

  test("a bound activation and control may close exactly their property", () => {
    const evidence = [{ path: "/evidence", sha256: "a".repeat(64), bytes: 1 }];
    expect(assessConfigurationPair("named consumption", [{ role: "activation", pass: true, evidence }, { role: "control", pass: true, evidence }]).status).toBe("pass");
  });
});
