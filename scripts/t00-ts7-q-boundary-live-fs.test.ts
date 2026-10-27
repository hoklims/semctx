import { expect, test } from "bun:test";
import { lstat, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeOracleLinks } from "./t00-ts7-q-boundary-common";
import { selectedExtractionProperties, partitionProperties, sourceIdentityProperties } from "./t00-ts7-q-boundary-live-fs";

const extraction = {
  modules: ["c.ts", "a.ts"],
  symbols: [{ relPath: "c.ts", name: "c", kind: "function", scope: [], exported: true }, { relPath: "a.ts", name: "a", kind: "function", scope: [], exported: true }],
  imports: [{ fromRelPath: "a.ts", moduleSpecifier: "./bridge", names: ["c"], resolvedRelPath: "bridge.ts" }],
  calls: [{ callerRelPath: "a.ts", callerSymbolPath: "a", calleeName: "c", calleeRelPath: "c.ts", calleeSymbolPath: "c", line: 2 }],
};

test("worker/direct evidence independently requires selected owners and the transitive call target", () => {
  expect(selectedExtractionProperties("direct", extraction).every(value => value.pass)).toBe(true);
  for (const changed of [
    {}, { ...extraction, modules: ["a.ts"] }, { ...extraction, symbols: [] },
    { ...extraction, modules: [...extraction.modules].reverse() }, { ...extraction, symbols: [...extraction.symbols].reverse() },
    { ...extraction, calls: [{ ...extraction.calls[0], calleeRelPath: "bridge.ts" }] },
    { ...extraction, imports: [] }, { ...extraction, symbols: [...extraction.symbols, extraction.symbols[0]] },
  ]) expect(selectedExtractionProperties("direct", changed).some(value => !value.pass)).toBe(true);
});

test("component evidence distinguishes the unselected bridge from a severed independent root", () => {
  const joined = { executed: true, unsupported: [], loadedRepositorySources: ["a.ts", "bridge.ts", "c.ts"], selectedRoots: ["a.ts", "c.ts"], dependencyComponents: [["a.ts", "c.ts"]], resolvedEdges: [{ from: "a.ts", specifier: "./bridge", to: "bridge.ts" }, { from: "bridge.ts", specifier: "./c", to: "c.ts" }] };
  expect(partitionProperties("joined", joined, true).every(value => value.pass)).toBe(true);
  expect(partitionProperties("severed", joined, false).some(value => !value.pass)).toBe(true);
  for (const changed of [{}, { ...joined, executed: false }, { ...joined, unsupported: ["missing"] }, { ...joined, selectedRoots: ["a.ts", "bridge.ts", "c.ts"] }, { ...joined, dependencyComponents: [["a.ts"], ["c.ts"]] }]) expect(partitionProperties("joined", changed, true).some(value => !value.pass)).toBe(true);
});


test("independent oracle creates real links only inside its isolated fixture", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "t00-oracle-live-links-")));
  try {
    await mkdir(join(root, "target"));
    await writeFile(join(root, "target", "entry.ts"), "export {};\n");
    const links = await materializeOracleLinks(root, { alias: "target" });
    expect(links).toEqual([{ path: join(root, "alias"), target: "target", canonical: join(root, "target") }]);
    expect(await realpath(join(root, "alias", "entry.ts"))).toBe(join(root, "target", "entry.ts"));
    for (const invalid of [{ "../escape": "target" }, { escape: "../outside" }, { malformed: 7 }, null, []]) expect(await materializeOracleLinks(root, invalid).then(() => false, () => true)).toBe(true);
    expect(await materializeOracleLinks(root, { absent: "missing.ts" }).then(() => false, () => true)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("oracle link confinement rejects existing lexical escape targets before writing links", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "t00-oracle-lexical-escape-")));
  const root = join(base, "repository"), outside = join(base, "outside");
  try {
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(outside, "entry.ts"), "export {};\n");
    for (const links of [{ "../outside/alias.ts": "entry.ts" }, { alias: "../outside/entry.ts" }]) {
      const rejection: unknown = await materializeOracleLinks(root, links).then(() => null, (error: unknown) => error);
      expect(rejection).toBeInstanceOf(Error);
      expect(rejection instanceof Error ? rejection.message : null).toBe("oracle symlink escapes isolated fixture");
    }
    for (const path of [join(outside, "alias.ts"), join(root, "alias")]) {
      expect(await lstat(path).then(() => "created", error => (error as NodeJS.ErrnoException).code)).toBe("ENOENT");
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("oracle link confinement rejects an existing external target reached through an internal link", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "t00-oracle-canonical-escape-")));
  const root = join(base, "repository"), outside = join(base, "outside");
  try {
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(outside, "entry.ts"), "export {};\n");
    await symlink(outside, join(root, "bridge"), process.platform === "win32" ? "junction" : "dir");
    const rejection: unknown = await materializeOracleLinks(root, { alias: "bridge/entry.ts" }).then(() => null, (error: unknown) => error);
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection instanceof Error ? rejection.message : null).toBe("oracle symlink canonical target escapes isolated fixture");
    await writeFile(join(root, "inside.ts"), "export {};\n");
    const accepted = await materializeOracleLinks(root, { internal: "inside.ts" });
    expect(accepted).toEqual([{ path: join(root, "internal"), target: "inside.ts", canonical: join(root, "inside.ts") }]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("source identity evidence requires the actual owner to consume the fault and preserve the lexical fallback", () => {
  const valid = { sourceIdentityObservation: { enabled: true, trace: [{ path: "/repo/alias.ts", key: "/repo/alias.ts", failedStage: "native_realpath", injected: true }] } };
  expect(sourceIdentityProperties("fault", valid, "/repo/alias.ts", "/repo/alias.ts", "native_realpath").every(row => row.pass)).toBe(true);
  for (const changed of [{}, { sourceIdentityObservation: { enabled: true, trace: [] } }, { sourceIdentityObservation: { enabled: true, trace: [{ path: "/repo/alias.ts", key: "/repo/target.ts", failedStage: "native_realpath", injected: true }] } }, { sourceIdentityObservation: { enabled: true, trace: [{ path: "/repo/alias.ts", key: "/repo/alias.ts", failedStage: null, injected: false }] } }]) {
    expect(sourceIdentityProperties("fault", changed, "/repo/alias.ts", "/repo/alias.ts", "native_realpath").some(row => !row.pass)).toBe(true);
  }
});
