import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cases, declaredExternalOracle, requireNativeManifestFailures, resolutionFromTrace } from "./t00-ts7-q-syntax-live-fs.js";

test("contract manifest ascent stops at malformed/self/local dependencies and repository root", async () => {
  const parent = await mkdtemp(join(tmpdir(), "t00-declared-external-"));
  const root = join(parent, "repo");
  const nested = join(root, "src");
  await mkdir(nested, { recursive: true });
  const file = join(nested, "main.js");
  try {
    await writeFile(join(parent, "package.json"), JSON.stringify({ dependencies: { outside: "1" } }));
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { external: "1", outside: "workspace:*" } }));
    expect((await declaredExternalOracle(file, root, "external/sub")).external).toBe(true);
    expect((await declaredExternalOracle(file, root, "outside")).external).toBe(false);
    expect((await declaredExternalOracle(file, undefined, "outside")).external).toBe(false);
    await writeFile(join(nested, "package.json"), "null");
    expect((await declaredExternalOracle(file, root, "external")).external).toBe(false);
    await writeFile(join(nested, "package.json"), "{");
    expect((await declaredExternalOracle(file, root, "external")).external).toBe(false);
    await writeFile(join(nested, "package.json"), JSON.stringify({ name: "external" }));
    expect((await declaredExternalOracle(file, root, "external/sub")).external).toBe(false);
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("TS7 trace requires an explicit per-specifier outcome", () => {
  expect(resolutionFromTrace("======== Module name './dep.js' was successfully resolved to '/repo/dep.js'. =====", "./dep.js")).toBe("resolved");
  expect(resolutionFromTrace("======== Module name 'absent' was not resolved. =====", "absent")).toBe("unresolved");
  expect(() => resolutionFromTrace("", "absent")).toThrow("resolution trace missing");
});

test("native failure witnesses reject missing, readable, wrong-error and wrong-path activations", () => {
  const workspace = "/native";
  const path = join(workspace, "repo/src/package.json");
  for (const [name, errorKind] of [["native-permission-read-failure", "PermissionDenied"], ["native-directory-read-failure", "IsADirectory"]]) {
    const item = cases.find(item => item.name === `LF-external-${name}`)!;
    for (const reads of [[], [{ path, found: true, error_kind: null }], [{ path, found: false, error_kind: "NotFound" }],
      [{ path: join(workspace, "different/package.json"), found: false, error_kind: errorKind! }],
      [{ path, found: true, error_kind: errorKind! }]]) {
      expect(() => requireNativeManifestFailures(item, workspace, reads)).toThrow("native manifest failure not activated");
    }
    expect(() => requireNativeManifestFailures(item, workspace, [{ path, found: false, error_kind: errorKind! }])).not.toThrow();
  }
});
