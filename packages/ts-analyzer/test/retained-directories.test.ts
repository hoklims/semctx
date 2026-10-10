import { expect, spyOn, test } from "bun:test";
import { retainedCompilerSystem } from "../src/ts-symbols";
test("retained directory probes reuse an ancestor inventory without allocating key scans", () => {
  const inputs = new Map(Array.from({ length: 2000 }, (_, index) => [`/fixture/package-${index}/src/main.ts`, "export {}; "]));
  const system = retainedCompilerSystem(inputs);
  const keys = spyOn(Map.prototype, "keys");
  try {
    for (let index = 0; index < 100; index++) {
      expect(system.directoryExists?.(`/fixture/package-${index}/src`)).toBe(true);
      expect(system.directoryExists?.(`/fixture/missing-${index}`)).toBe(false);
    }
    expect(keys).not.toHaveBeenCalled();
  } finally { keys.mockRestore(); }
});
