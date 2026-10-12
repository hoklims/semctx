import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inspectModuleConfiguration } from "../src/javascript-diagnostics";
import { resolveTypeScriptModule } from "../src/ts-symbols";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A canonical temporary root: macOS reaches tmpdir through the `/var` → `/private/var` link,
 *  which would otherwise put every realpath'd configuration outside the analyzed root. */
function temporaryRoot(prefix: string): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), prefix))).replaceAll("\\", "/");
  roots.push(root);
  return root;
}

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

const CONFIG_MEMBER = {
  "tooling/config/package.json": JSON.stringify({
    name: "@fixture/config",
    version: "1.0.0",
    exports: { "./tsconfig/node.json": "./tsconfig/node.json", "./tsconfig/base.json": "./tsconfig/base.json" },
  }),
  "tooling/config/tsconfig/base.json": JSON.stringify({
    compilerOptions: { strict: true, module: "ESNext", moduleResolution: "Bundler", paths: { "#shared": ["./shared.ts"] } },
  }),
  "tooling/config/tsconfig/shared.ts": "export const shared = 1;\n",
  "tooling/config/tsconfig/node.json": JSON.stringify({ extends: "./base.json", compilerOptions: { noEmit: true } }),
};

/** A pnpm workspace whose package inherits its compiler options from another member. */
function workspace(dependency = "workspace:*", declaration: Record<string, string> = {
  "pnpm-workspace.yaml": "packages:\n  - \"tooling/*\"\n  - \"domains/*/*\"\n",
}): { root: string; source: string } {
  const root = temporaryRoot("semctx-workspace-links-");
  mkdirSync(join(root, ".git"));
  write(root, {
    "package.json": JSON.stringify({ name: "fixture-root", private: true }),
    ...declaration,
    ...CONFIG_MEMBER,
    "domains/registry/api/package.json": JSON.stringify({
      name: "@fixture/registry-api",
      devDependencies: { "@fixture/config": dependency },
    }),
    "domains/registry/api/tsconfig.json": JSON.stringify({ extends: "@fixture/config/tsconfig/node.json" }),
    "domains/registry/api/src/registry.ts": "export const registry = 1;\n",
  });
  return { root, source: `${root}/domains/registry/api/src/registry.ts` };
}

function configurationFailures(reasons: readonly string[]): string[] {
  return reasons.filter(reason => reason.startsWith("SOURCE_CONFIGURATION_"));
}

test("a workspace: dependency resolves an uninstalled member configuration (pnpm-workspace.yaml)", () => {
  const { root, source } = workspace();
  expect(configurationFailures(inspectModuleConfiguration(source, root))).toEqual([]);
});

test("a workspace: dependency resolves an uninstalled member configuration (package.json workspaces)", () => {
  const { root, source } = workspace("workspace:^", {
    "package.json": JSON.stringify({ name: "fixture-root", private: true, workspaces: { packages: ["tooling/*", "domains/*/*"] } }),
  });
  expect(configurationFailures(inspectModuleConfiguration(source, root))).toEqual([]);
});

test("module resolution inherits the options of a linked member configuration", () => {
  const { root, source } = workspace();
  expect(resolveTypeScriptModule("#shared", source, undefined, true)).toBe(`${root}/tooling/config/tsconfig/shared.ts`);
});

test("a registry version range is not a workspace link", () => {
  const { root, source } = workspace("^1.0.0");
  expect(configurationFailures(inspectModuleConfiguration(source, root)).some(reason => reason.startsWith("SOURCE_CONFIGURATION_INVALID:6053"))).toBe(true);
  expect(resolveTypeScriptModule("#shared", source, undefined, true)).toBeUndefined();
});

test("a package outside the declared members receives no link", () => {
  const { root, source } = workspace("workspace:*", { "pnpm-workspace.yaml": "packages:\n  - \"tooling/*\"\n" });
  expect(configurationFailures(inspectModuleConfiguration(source, root)).some(reason => reason.startsWith("SOURCE_CONFIGURATION_INVALID:6053"))).toBe(true);
});

test("an excluded member receives no link", () => {
  const { root, source } = workspace("workspace:*", {
    "pnpm-workspace.yaml": "packages:\n  - \"tooling/*\"\n  - \"domains/*/*\"\n  - \"!tooling/config\"\n",
  });
  expect(configurationFailures(inspectModuleConfiguration(source, root)).some(reason => reason.startsWith("SOURCE_CONFIGURATION_INVALID:6053"))).toBe(true);
});

test("an ambiguous member name receives no link", () => {
  const { root, source } = workspace();
  // A complete second member, so either candidate alone would resolve.
  write(root, Object.fromEntries(Object.entries(CONFIG_MEMBER).map(([path, content]) => [path.replace("tooling/config/", "tooling/config-copy/"), content])));
  expect(configurationFailures(inspectModuleConfiguration(source, root)).some(reason => reason.startsWith("SOURCE_CONFIGURATION_INVALID:6053"))).toBe(true);
  expect(resolveTypeScriptModule("#shared", source, undefined, true)).toBeUndefined();
});

test("an installed dependency keeps precedence over the workspace link", () => {
  const { root, source } = workspace();
  write(root, {
    "domains/registry/api/node_modules/@fixture/config/package.json": JSON.stringify({
      name: "@fixture/config", exports: { "./tsconfig/node.json": "./tsconfig/node.json" },
    }),
    "domains/registry/api/node_modules/@fixture/config/tsconfig/node.json": JSON.stringify({ compilerOptions: { module: "NotAModule" } }),
  });
  expect(configurationFailures(inspectModuleConfiguration(source, root)).some(reason => reason.startsWith("SOURCE_CONFIGURATION_INVALID:6046"))).toBe(true);
});

test("a workspace declared above the repository boundary receives no link", () => {
  const parent = temporaryRoot("semctx-workspace-boundary-");
  write(parent, {
    "pnpm-workspace.yaml": "packages:\n  - \"repo/tooling/*\"\n  - \"repo/domains/*/*\"\n",
    ...Object.fromEntries(Object.entries(CONFIG_MEMBER).map(([path, content]) => [`repo/${path}`, content])),
    "repo/domains/registry/api/package.json": JSON.stringify({ name: "@fixture/registry-api", devDependencies: { "@fixture/config": "workspace:*" } }),
    "repo/domains/registry/api/tsconfig.json": JSON.stringify({ extends: "@fixture/config/tsconfig/node.json" }),
    "repo/domains/registry/api/src/registry.ts": "export const registry = 1;\n",
  });
  mkdirSync(join(parent, "repo", ".git"));
  const root = `${parent}/repo`;
  const source = `${root}/domains/registry/api/src/registry.ts`;
  expect(configurationFailures(inspectModuleConfiguration(source, root)).some(reason => reason.startsWith("SOURCE_CONFIGURATION_INVALID:6053"))).toBe(true);
  // Module resolution has no analyzed root: the `.git` marker is its boundary.
  expect(resolveTypeScriptModule("#shared", source, undefined, true)).toBeUndefined();
});

function failsToResolve(root: string, source: string, code = "6053"): boolean {
  return configurationFailures(inspectModuleConfiguration(source, root)).some(reason => reason.startsWith(`SOURCE_CONFIGURATION_INVALID:${code}`));
}

test("a traversal pattern cannot add a member outside the workspace root", () => {
  const parent = temporaryRoot("semctx-workspace-traversal-");
  write(parent, {
    ...Object.fromEntries(Object.entries(CONFIG_MEMBER).map(([path, content]) => [path.replace("tooling/", "outside/"), content])),
    "repo/pnpm-workspace.yaml": "packages:\n  - \"domains/*/*\"\n  - \"../outside/*\"\n",
    "repo/domains/registry/api/package.json": JSON.stringify({ name: "@fixture/registry-api", devDependencies: { "@fixture/config": "workspace:*" } }),
    "repo/domains/registry/api/tsconfig.json": JSON.stringify({ extends: "@fixture/config/tsconfig/node.json" }),
    "repo/domains/registry/api/src/registry.ts": "export const registry = 1;\n",
  });
  mkdirSync(join(parent, "repo", ".git"));
  const root = `${parent}/repo`;
  const source = `${root}/domains/registry/api/src/registry.ts`;
  expect(failsToResolve(root, source)).toBe(true);
  expect(resolveTypeScriptModule("#shared", source, undefined, true)).toBeUndefined();
});

test("a ./ prefixed workspace pattern names the same members", () => {
  const { root, source } = workspace("workspace:*", { "pnpm-workspace.yaml": "packages:\n  - \"./tooling/*\"\n  - \"./domains/*/*\"\n" });
  expect(configurationFailures(inspectModuleConfiguration(source, root))).toEqual([]);
  const excluded = workspace("workspace:*", {
    "pnpm-workspace.yaml": "packages:\n  - \"./tooling/*\"\n  - \"./domains/*/*\"\n  - \"!./tooling/config\"\n",
  });
  expect(failsToResolve(excluded.root, excluded.source)).toBe(true);
});

test("a comparator workspace range is a workspace link", () => {
  const { root, source } = workspace("workspace:>=0.0.0");
  expect(configurationFailures(inspectModuleConfiguration(source, root))).toEqual([]);
});

test("an installed package directory never falls back to the workspace member", () => {
  const { root, source } = workspace();
  write(root, {
    "domains/registry/api/node_modules/@fixture/config/package.json": JSON.stringify({ name: "@fixture/config" }),
  });
  expect(failsToResolve(root, source)).toBe(true);
});

test("a hoisted installed package keeps precedence over the workspace link", () => {
  const { root, source } = workspace();
  write(root, {
    "node_modules/@fixture/config/package.json": JSON.stringify({
      name: "@fixture/config", exports: { "./tsconfig/node.json": "./tsconfig/node.json" },
    }),
    "node_modules/@fixture/config/tsconfig/node.json": JSON.stringify({ compilerOptions: { module: "NotAModule" } }),
  });
  expect(failsToResolve(root, source, "6046")).toBe(true);
});

test("each analysis pass observes the current workspace members", () => {
  const { root, source } = workspace();
  expect(configurationFailures(inspectModuleConfiguration(source, root))).toEqual([]);
  const duplicate = Object.fromEntries(Object.entries(CONFIG_MEMBER).map(([path, content]) => [path.replace("tooling/config/", "tooling/config-copy/"), content]));
  write(root, duplicate);
  expect(failsToResolve(root, source)).toBe(true);
  rmSync(join(root, "tooling", "config-copy"), { recursive: true, force: true });
  expect(configurationFailures(inspectModuleConfiguration(source, root))).toEqual([]);
});

test("a member may depend on the workspace root package", () => {
  const { root, source } = workspace();
  write(root, {
    "package.json": JSON.stringify({ name: "@fixture/root-config", private: true, exports: { "./tsconfig/root.json": "./tsconfig/root.json" } }),
    "tsconfig/root.json": JSON.stringify({ compilerOptions: { strict: true } }),
    "domains/registry/api/package.json": JSON.stringify({ name: "@fixture/registry-api", devDependencies: { "@fixture/root-config": "workspace:*" } }),
    "domains/registry/api/tsconfig.json": JSON.stringify({ extends: "@fixture/root-config/tsconfig/root.json" }),
  });
  expect(configurationFailures(inspectModuleConfiguration(source, root))).toEqual([]);
  // A member repeating the root package name makes it ambiguous.
  write(root, { "tooling/root-copy/package.json": JSON.stringify({ name: "@fixture/root-config" }) });
  expect(failsToResolve(root, source)).toBe(true);
});

test("an enclosing pnpm workspace governs a member that declares package workspaces", () => {
  const { root, source } = workspace();
  write(root, {
    "domains/registry/api/package.json": JSON.stringify({
      name: "@fixture/registry-api",
      workspaces: ["nested/*"],
      devDependencies: { "@fixture/config": "workspace:*" },
    }),
  });
  expect(configurationFailures(inspectModuleConfiguration(source, root))).toEqual([]);
});

test("a workspace range the member version does not satisfy receives no link", () => {
  for (const [range, linked] of [["workspace:^1.0.0", true], ["workspace:^2.0.0", false], ["workspace:not a range", false]] as const) {
    const { root, source } = workspace(range);
    expect(failsToResolve(root, source)).toBe(!linked);
  }
});

test("a nested Git worktree is not a workspace member", () => {
  const { root, source } = workspace();
  write(root, { "tooling/config/.git": "gitdir: ../../.git/worktrees/config\n" });
  expect(failsToResolve(root, source)).toBe(true);
});

test("a repository below an ancestor node_modules directory still links its members", () => {
  const parent = temporaryRoot("semctx-workspace-ancestor-");
  const base = `${parent}/node_modules/repo`;
  write(base, {
    "package.json": JSON.stringify({ name: "fixture-root", private: true }),
    "pnpm-workspace.yaml": "packages:\n  - \"tooling/*\"\n  - \"domains/*/*\"\n",
    ...CONFIG_MEMBER,
    "domains/registry/api/package.json": JSON.stringify({ name: "@fixture/registry-api", devDependencies: { "@fixture/config": "workspace:*" } }),
    "domains/registry/api/tsconfig.json": JSON.stringify({ extends: "@fixture/config/tsconfig/node.json" }),
    "domains/registry/api/src/registry.ts": "export const registry = 1;\n",
  });
  mkdirSync(join(base, ".git"));
  const source = `${base}/domains/registry/api/src/registry.ts`;
  expect(configurationFailures(inspectModuleConfiguration(source, base))).toEqual([]);
  expect(resolveTypeScriptModule("#shared", source, undefined, true)).toBe(`${base}/tooling/config/tsconfig/shared.ts`);
});
