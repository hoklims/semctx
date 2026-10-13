import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import ts from "typescript";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { inspectJavaScriptSource, inspectModuleConfiguration } from "../src/javascript-diagnostics";
import { extractTypeScript, resolveTypeScriptModule } from "../src/ts-symbols";
import { createWorkspaceLinkResolver, workspaceLinkedSystem } from "../src/workspace-links";

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

test("a pnpm workspace above the repository boundary does not shadow its package workspaces", () => {
  const parent = temporaryRoot("semctx-workspace-shadow-");
  write(parent, {
    "pnpm-workspace.yaml": "packages:\n  - \"repo/**\"\n",
    "repo/package.json": JSON.stringify({ name: "fixture-root", private: true, workspaces: ["tooling/*", "domains/*/*"] }),
    ...Object.fromEntries(Object.entries(CONFIG_MEMBER).map(([path, content]) => [`repo/${path}`, content])),
    "repo/domains/registry/api/package.json": JSON.stringify({ name: "@fixture/registry-api", devDependencies: { "@fixture/config": "workspace:*" } }),
    "repo/domains/registry/api/tsconfig.json": JSON.stringify({ extends: "@fixture/config/tsconfig/node.json" }),
    "repo/domains/registry/api/src/registry.ts": "export const registry = 1;\n",
  });
  mkdirSync(join(parent, "repo", ".git"));
  const root = `${parent}/repo`;
  const source = `${root}/domains/registry/api/src/registry.ts`;
  expect(configurationFailures(inspectModuleConfiguration(source, root))).toEqual([]);
  // Without an analyzed root, only the `.git` marker keeps the outer pnpm declaration from governing.
  expect(resolveTypeScriptModule("#shared", source, undefined, true)).toBe(`${root}/tooling/config/tsconfig/shared.ts`);
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
  for (const [range, linked] of [["workspace:^1.0.0", true], ["workspace:>= 1.0.0", true], ["workspace:>= 2.0.0", false], ["workspace:^2.0.0", false], ["workspace:not a range", false]] as const) {
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

test("a pnpm workspace file without usable packages patterns links no member", () => {
  for (const pnpm of ["autoInstallPeers: false\n", "packages: \"tooling/*\"\n", "packages: [\n"]) {
    const { root, source } = workspace("workspace:*", {
      "pnpm-workspace.yaml": pnpm,
      "package.json": JSON.stringify({ name: "fixture-root", private: true, workspaces: ["tooling/*", "domains/*/*"] }),
    });
    expect(failsToResolve(root, source)).toBe(true);
  }
});

test("a peer-only workspace dependency receives no link", () => {
  const { root, source } = workspace();
  write(root, {
    "domains/registry/api/package.json": JSON.stringify({ name: "@fixture/registry-api", peerDependencies: { "@fixture/config": "workspace:*" } }),
  });
  expect(failsToResolve(root, source)).toBe(true);
  write(root, {
    "domains/registry/api/package.json": JSON.stringify({
      name: "@fixture/registry-api", peerDependencies: { "@fixture/config": "workspace:*" }, devDependencies: { "@fixture/config": "workspace:*" },
    }),
  });
  expect(configurationFailures(inspectModuleConfiguration(source, root))).toEqual([]);
});

function canCreateFileSymlink(): boolean {
  if (process.platform !== "win32") return true;
  const root = temporaryRoot("semctx-workspace-symlink-capability-");
  write(root, { "target.json": "{}" });
  try {
    symlinkSync(join(root, "target.json"), join(root, "link.json"), "file");
    return true;
  } catch (error) {
    if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

test.skipIf(!canCreateFileSymlink())("a symlinked workspace configuration cannot read outside the repository", () => {
  const { root, source } = workspace();
  const outside = temporaryRoot("semctx-workspace-external-config-");
  write(outside, { "base.json": JSON.stringify({ compilerOptions: { module: "ESNext" } }) });
  rmSync(join(root, "tooling/config/tsconfig/base.json"));
  symlinkSync(join(outside, "base.json"), join(root, "tooling/config/tsconfig/base.json"), "file");
  const resolver = createWorkspaceLinkResolver();
  expect(configurationFailures(inspectModuleConfiguration(source, root, undefined, undefined, resolver))
    .some(reason => reason.startsWith("SOURCE_CONFIGURATION_INVALID:"))).toBe(true);
  expect([...resolver.inputs.values()].some(content => content?.includes('"module":"ESNext"'))).toBe(false);
});

test("a linked ancestor of workspace configuration cannot read outside the repository", () => {
  const { root, source } = workspace();
  const outside = temporaryRoot("semctx-workspace-external-directory-");
  write(outside, { "node.json": JSON.stringify({ compilerOptions: { module: "ESNext" } }) });
  rmSync(join(root, "tooling/config/tsconfig"), { recursive: true });
  symlinkSync(outside, join(root, "tooling/config/tsconfig"), process.platform === "win32" ? "junction" : "dir");
  const resolver = createWorkspaceLinkResolver();
  expect(configurationFailures(inspectModuleConfiguration(source, root, undefined, undefined, resolver))
    .some(reason => reason.startsWith("SOURCE_CONFIGURATION_INVALID:"))).toBe(true);
  expect([...resolver.inputs.values()].some(content => content?.includes('"module":"ESNext"'))).toBe(false);
});

test.skipIf(!canCreateFileSymlink())("relative inherited workspace configuration refuses a sibling symlink", () => {
  const { root, source } = workspace();
  const outside = temporaryRoot("semctx-workspace-external-sibling-");
  const external = JSON.stringify({ compilerOptions: { module: "ESNext" } });
  write(outside, { "escape.json": external });
  write(root, { "tooling/config/tsconfig/node.json": JSON.stringify({ extends: "../../sibling/escape.json" }) });
  mkdirSync(join(root, "tooling/sibling"));
  const target = `${root}/tooling/sibling/escape.json`;
  symlinkSync(join(outside, "escape.json"), target, "file");
  const resolver = createWorkspaceLinkResolver();
  expect(configurationFailures(inspectModuleConfiguration(source, root, undefined, undefined, resolver))
    .some(reason => reason.startsWith("SOURCE_CONFIGURATION_INVALID:"))).toBe(true);
  expect([...resolver.inputs.values()]).not.toContain(external);
  expect(resolver.inputs.has(target)).toBe(true);
  expect(resolver.inputs.get(target)).toBeUndefined();
  rmSync(target);
  write(root, { "tooling/sibling/escape.json": external });
  expect(configurationFailures(inspectModuleConfiguration(source, root))).toEqual([]);
});

test.skipIf(!canCreateFileSymlink())("physical inherited node_modules configuration refuses external symlinks", () => {
  for (const suffix of ["node_modules/escape.json", "node_modules/installed/escape.json"]) {
    const { root, source } = workspace();
    const outside = temporaryRoot("semctx-workspace-external-node-modules-");
    const external = JSON.stringify({ compilerOptions: { module: "ESNext" } });
    write(outside, { "escape.json": external });
    write(root, { "tooling/config/tsconfig/node.json": JSON.stringify({ extends: `../../${suffix}` }) });
    const target = `${root}/tooling/${suffix}`;
    mkdirSync(join(target, ".."), { recursive: true });
    symlinkSync(join(outside, "escape.json"), target, "file");
    const resolver = createWorkspaceLinkResolver();
    expect(configurationFailures(inspectModuleConfiguration(source, root, undefined, undefined, resolver))
      .some(reason => reason.startsWith("SOURCE_CONFIGURATION_INVALID:"))).toBe(true);
    expect([...resolver.inputs.values()]).not.toContain(external);
    expect(resolver.inputs.has(target)).toBe(true);
    expect(resolver.inputs.get(target)).toBeUndefined();
    rmSync(target);
    write(root, { [`tooling/${suffix}`]: external });
    expect(configurationFailures(inspectModuleConfiguration(source, root))).toEqual([]);
  }
});

test("linked configuration preserves local and hoisted installed package precedence", () => {
  for (const installedRoot of ["tooling/config/node_modules", "node_modules"]) {
    const { root, source } = workspace();
    write(root, {
      "tooling/config/package.json": JSON.stringify({ name: "@fixture/config", devDependencies: { "@fixture/installed": "workspace:*" } }),
      "tooling/config/tsconfig/node.json": JSON.stringify({ extends: "@fixture/installed/base.json" }),
      "tooling/installed/package.json": JSON.stringify({ name: "@fixture/installed" }),
      "tooling/installed/base.json": JSON.stringify({ compilerOptions: { module: "ESNext" } }),
      [`${installedRoot}/@fixture/installed/package.json`]: JSON.stringify({ name: "@fixture/installed" }),
      [`${installedRoot}/@fixture/installed/base.json`]: JSON.stringify({ compilerOptions: { module: "NotAModule" } }),
    });
    expect(configurationFailures(inspectModuleConfiguration(source, root))
      .some(reason => reason.startsWith("SOURCE_CONFIGURATION_INVALID:6046"))).toBe(true);
  }
});

test("linked configuration preserves in-root installed package links after synthetic resolution", () => {
  for (const installedRoot of ["tooling/config/node_modules", "node_modules"]) {
    const { root, source } = workspace();
    write(root, {
      "tooling/config/package.json": JSON.stringify({ name: "@fixture/config", devDependencies: { "@fixture/installed": "workspace:*" } }),
      "tooling/config/tsconfig/node.json": JSON.stringify({ extends: "@fixture/installed/base.json" }),
      "tooling/installed/package.json": JSON.stringify({ name: "@fixture/installed" }),
      "tooling/installed/base.json": JSON.stringify({ compilerOptions: { module: "ESNext" } }),
      "vendor/installed/package.json": JSON.stringify({ name: "@fixture/installed" }),
      "vendor/installed/base.json": JSON.stringify({ compilerOptions: { module: "NotAModule" } }),
    });
    mkdirSync(join(root, installedRoot, "@fixture"), { recursive: true });
    symlinkSync(join(root, "vendor/installed"), join(root, installedRoot, "@fixture/installed"), process.platform === "win32" ? "junction" : "dir");
    const resolver = createWorkspaceLinkResolver();
    expect(configurationFailures(inspectModuleConfiguration(source, root, undefined, undefined, resolver))
      .some(reason => reason.startsWith("SOURCE_CONFIGURATION_INVALID:6046"))).toBe(true);
    expect([...resolver.links.values()].some(links => links.has("@fixture/config"))).toBe(true);
    expect([...resolver.links.values()].some(links => links.has("@fixture/installed"))).toBe(false);
  }
});

for (const virtual of [false, true]) {
  test(`configured module resolution refuses external ${virtual ? "virtual" : "real"} node_modules inputs`, () => {
    const { root, source } = workspace();
    const outside = temporaryRoot("semctx-workspace-outside-resolution-");
    write(outside, {
      "package.json": JSON.stringify({ name: "external-root", private: true, workspaces: ["consumer", "members/*"] }),
      "consumer/package.json": JSON.stringify({ name: "external-consumer", devDependencies: { "@fixture/external": "workspace:*" } }),
      "members/config/package.json": JSON.stringify({ name: "@fixture/external" }),
      "members/config/base.json": JSON.stringify({ compilerOptions: { paths: { "#external": [`${outside}/target.ts`] } } }),
      "target.ts": "export const external = 1;\n",
    });
    if (!virtual) write(outside, { "consumer/node_modules/@fixture/external/base.json": JSON.stringify({ compilerOptions: { paths: { "#external": [`${outside}/target.ts`] } } }) });
    write(root, { "tooling/config/tsconfig/node.json": JSON.stringify({ extends: `${outside}/consumer/node_modules/@fixture/external/base.json` }) });
    expect(resolveTypeScriptModule("#external", source, undefined, true)).toBeUndefined();
  });
}

test.skipIf(!canCreateFileSymlink())("a dangling Git marker prevents inheriting an outer workspace", () => {
  const parent = temporaryRoot("semctx-workspace-dangling-root-");
  write(parent, {
    "pnpm-workspace.yaml": 'packages:\n  - "repo/tooling/*"\n  - "repo/domains/*/*"\n',
    ...Object.fromEntries(Object.entries(CONFIG_MEMBER).map(([path, content]) => [`repo/${path}`, content])),
    "repo/domains/registry/api/package.json": JSON.stringify({ name: "@fixture/api", devDependencies: { "@fixture/config": "workspace:*" } }),
    "repo/domains/registry/api/tsconfig.json": JSON.stringify({ extends: "@fixture/config/tsconfig/node.json" }),
    "repo/domains/registry/api/src/registry.ts": "export const registry = 1;\n",
  });
  const root = `${parent}/repo`;
  symlinkSync(join(parent, "missing-git-marker"), join(root, ".git"), "file");
  expect(resolveTypeScriptModule("#shared", `${root}/domains/registry/api/src/registry.ts`, undefined, true)).toBeUndefined();
});

test.skipIf(!canCreateFileSymlink())("a dangling Git marker excludes a nested workspace member", () => {
  const { root, source } = workspace();
  symlinkSync(join(root, "missing-git-marker"), join(root, "tooling/config/.git"), "file");
  expect(failsToResolve(root, source)).toBe(true);
});

test("JavaScript configuration resolution binds the selected repository before inherited reads", () => {
  const { root } = workspace();
  const selectedRoot = `${root}/domains/registry/api`;
  const source = `${selectedRoot}/src/registry.js`;
  const content = 'import { shared } from "#shared"; export const registry = shared;\n';
  write(root, { "domains/registry/api/src/registry.js": content });
  const resolver = createWorkspaceLinkResolver();
  const result = inspectJavaScriptSource(source, content, selectedRoot, undefined, resolver);
  expect(result.staticModuleLinks.find(link => link.specifier === "#shared")?.resolution).toBe("unresolved");
  expect([...resolver.inputs.values()]).not.toContain(CONFIG_MEMBER["tooling/config/tsconfig/base.json"]);
  const extraction = extractTypeScript([source], selectedRoot);
  expect(extraction.imports.find(link => link.moduleSpecifier === "#shared")?.resolvedRelPath).toBeUndefined();
  expect(inspectJavaScriptSource(source, content, root, undefined, resolver).staticModuleLinks
    .find(link => link.specifier === "#shared")?.resolution).toBe("resolved");
  expect(inspectJavaScriptSource(source, content, selectedRoot, undefined, resolver).staticModuleLinks
    .find(link => link.specifier === "#shared")?.resolution).toBe("unresolved");
});

test("legacy TS-only extraction does not consume live workspace configuration", () => {
  const { root, source } = workspace();
  write(root, { "domains/registry/api/src/registry.ts": 'import { shared } from "#shared"; export const registry = shared;\n' });
  const before = extractTypeScript([source], root);
  expect(before.imports.find(link => link.moduleSpecifier === "#shared")?.resolvedRelPath).toBeUndefined();
  write(root, { "domains/registry/api/package.json": JSON.stringify({ name: "@fixture/api", devDependencies: { "@fixture/config": "^1.0.0" } }) });
  expect(extractTypeScript([source], root)).toEqual(before);
});

function linkedInitialConfiguration(): { root: string; source: string; content: string; external: string } {
  const root = temporaryRoot("semctx-workspace-initial-config-");
  const outside = temporaryRoot("semctx-workspace-initial-config-outside-");
  const content = 'import { external } from "#external"; export const value = external;\n';
  const external = JSON.stringify({ compilerOptions: { paths: { "#external": [`${outside}/target.ts`] } } });
  write(outside, { "config.json": external, "target.ts": "export const external = 1;\n" });
  write(root, {
    "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "#external": ["./safe.ts"] } } }),
    "safe.ts": "export const external = 0;\n",
    "src/source.js": content,
  });
  symlinkSync(join(outside, "config.json"), join(root, "src/tsconfig.json"), "file");
  return { root, source: `${root}/src/source.js`, content, external };
}

test.skipIf(!canCreateFileSymlink())("bounded resolution refuses initial config bytes with an empty link cache", () => {
  const { root, source, external } = linkedInitialConfiguration();
  const resolver = createWorkspaceLinkResolver();
  expect(resolveTypeScriptModule("#external", source, undefined, true, undefined, resolver, root)).toBeUndefined();
  expect([...resolver.inputs.values()]).not.toContain(external);
  expect(resolver.inputs.has(`${root}/src/tsconfig.json`)).toBe(true);
  expect(resolver.inputs.get(`${root}/src/tsconfig.json`)).toBeUndefined();
});

test.skipIf(!canCreateFileSymlink())("JavaScript diagnostics retain an invalid closest initial config without reading it", () => {
  const { root, source, content, external } = linkedInitialConfiguration();
  const resolver = createWorkspaceLinkResolver();
  const result = inspectJavaScriptSource(source, content, root, undefined, resolver);
  expect(result.staticModuleLinks.find(link => link.specifier === "#external")?.resolution).toBe("unresolved");
  expect(result.reasons.some(reason => reason.startsWith("SOURCE_CONFIGURATION_INVALID:"))).toBe(true);
  expect([...resolver.inputs.values()]).not.toContain(external);
});

test.skipIf(!canCreateFileSymlink())("an unsafe closest initial config stays invalid after a real workspace link was resolved", () => {
  const { root, source } = workspace();
  const outside = temporaryRoot("semctx-workspace-initial-after-link-");
  const external = JSON.stringify({ compilerOptions: { paths: { "#external": [`${outside}/target.ts`] } } });
  write(outside, { "config.json": external, "target.ts": "export const external = 1;\n" });
  const resolver = createWorkspaceLinkResolver();
  expect(inspectModuleConfiguration(source, root, undefined, undefined, resolver)).toEqual([]);
  expect([...resolver.links.values()].some(links => links.size > 0)).toBe(true);
  write(root, { "domains/registry/api/tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "#external": [`${root}/tooling/config/tsconfig/shared.ts`] } } }) });
  symlinkSync(join(outside, "config.json"), join(root, "domains/registry/api/src/tsconfig.json"), "file");
  expect(resolveTypeScriptModule("#external", source, undefined, true, undefined, resolver, root)).toBeUndefined();
  expect(configurationFailures(inspectModuleConfiguration(source, root, undefined, undefined, resolver))
    .some(reason => reason.startsWith("SOURCE_CONFIGURATION_INVALID:"))).toBe(true);
  expect([...resolver.inputs.values()]).not.toContain(external);
  rmSync(join(root, "domains/registry/api/src/tsconfig.json"));
  symlinkSync(join(root, "domains/registry/api/tsconfig.json"), join(root, "domains/registry/api/src/tsconfig.json"), "file");
  expect(resolveTypeScriptModule("#external", source, undefined, true, undefined, resolver, root)).toBe(`${root}/tooling/config/tsconfig/shared.ts`);
  expect(configurationFailures(inspectModuleConfiguration(source, root, undefined, undefined, resolver))).toEqual([]);
});

test.skipIf(!canCreateFileSymlink())("a canonical in-root initial config alias remains usable", () => {
  const { root, source } = linkedInitialConfiguration();
  write(root, { "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "#external": [`${root}/safe.ts`] } } }) });
  rmSync(join(root, "src/tsconfig.json"));
  symlinkSync(join(root, "tsconfig.json"), join(root, "src/tsconfig.json"), "file");
  expect(resolveTypeScriptModule("#external", source, undefined, true, undefined, undefined, root)).toBe(`${root}/safe.ts`);
  expect(configurationFailures(inspectModuleConfiguration(source, root))).toEqual([]);
});

test.skipIf(!canCreateFileSymlink())("a present unadmitted pnpm declaration cannot fall back to package workspaces", () => {
  for (const dangling of [false, true]) {
    const { root, source } = workspace();
    const governing = 'packages:\n  - "domains/*/*"\n';
    write(root, { "package.json": JSON.stringify({ name: "root", private: true, workspaces: ["tooling/*", "domains/*/*"] }) });
    if (!dangling) write(root, { "governing.yaml": governing });
    rmSync(join(root, "pnpm-workspace.yaml"));
    symlinkSync(join(root, "governing.yaml"), join(root, "pnpm-workspace.yaml"), "file");
    const resolver = createWorkspaceLinkResolver();
    expect(configurationFailures(inspectModuleConfiguration(source, root, undefined, undefined, resolver))
      .some(reason => reason.startsWith("SOURCE_CONFIGURATION_INVALID:"))).toBe(true);
    expect([...resolver.inputs.values()]).not.toContain(governing);
    expect(resolver.inputs.has(`${root}/pnpm-workspace.yaml`)).toBe(true);
    expect(resolver.inputs.get(`${root}/pnpm-workspace.yaml`)).toBeUndefined();
    // Only actual absence restores the normal package.json workspace fallback.
    rmSync(join(root, "pnpm-workspace.yaml"));
    expect(configurationFailures(inspectModuleConfiguration(source, root))).toEqual([]);
  }
});

test("an unreadable present pnpm declaration cannot fall back to package workspaces", () => {
  const { root, source } = workspace();
  write(root, { "package.json": JSON.stringify({ name: "root", private: true, workspaces: ["tooling/*", "domains/*/*"] }) });
  const originalRead = fs.readFileSync;
  const probe = spyOn(fs, "readFileSync").mockImplementation(((path, options) => {
    if (String(path).replaceAll("\\", "/") === `${root}/pnpm-workspace.yaml`) {
      throw Object.assign(new Error("workspace declaration access denied"), { code: "EACCES" });
    }
    return originalRead(path, options);
  }) as typeof fs.readFileSync);
  try {
    expect(failsToResolve(root, source)).toBe(true);
  } finally {
    probe.mockRestore();
  }
});

for (const inherited of [false, true]) for (const mapping of ["baseUrl", "paths"] as const) {
  test(`configured ${mapping} resolution refuses external sources (${inherited ? "linked" : "direct"} config)`, () => {
    const { root } = workspace();
    const outside = temporaryRoot("semctx-workspace-outside-module-");
    const specifier = mapping === "paths" ? "#external" : "external";
    const source = `${root}/domains/registry/api/src/source.js`;
    const content = `import { external } from "${specifier}"; export const value = external;\n`;
    write(outside, { "external.ts": "export const external = 1;\n" });
    write(root, { "domains/registry/api/src/source.js": content });
    const configPath = inherited ? "tooling/config/tsconfig/node.json" : "domains/registry/api/tsconfig.json";
    const options = (targetRoot: string) => ({ module: "ESNext", moduleResolution: "Bundler",
      ...(mapping === "baseUrl" ? { baseUrl: targetRoot } : { paths: { "#external": [`${targetRoot}/external.ts`] } }) });
    write(root, { [configPath]: JSON.stringify({ compilerOptions: options(outside) }) });
    const resolver = createWorkspaceLinkResolver();
    expect(resolveTypeScriptModule(specifier, source, undefined, true, undefined, resolver, root)).toBeUndefined();
    expect(inspectJavaScriptSource(source, content, root).staticModuleLinks.find(link => link.specifier === specifier)?.resolution).toBe("unresolved");
    expect(extractTypeScript([source], root).imports.find(link => link.moduleSpecifier === specifier)?.resolvedRelPath).toBeUndefined();
    write(root, { "internal/external.ts": "export const external = 0;\n", [configPath]: JSON.stringify({ compilerOptions: options(`${root}/internal`) }) });
    expect(resolveTypeScriptModule(specifier, source, undefined, true, undefined, undefined, root)).toBe(`${root}/internal/external.ts`);
  });
}

test("configured source resolution does not synthesize uninstalled source-package links", () => {
  const { root, source } = workspace();
  write(root, {
    "tooling/source/package.json": JSON.stringify({ name: "@fixture/source", types: "index.ts" }),
    "tooling/source/index.ts": "export const source = 1;\n",
    "domains/registry/api/package.json": JSON.stringify({ name: "@fixture/api", devDependencies: { "@fixture/config": "workspace:*", "@fixture/source": "workspace:*" } }),
  });
  expect(configurationFailures(inspectModuleConfiguration(source, root))).toEqual([]);
  expect(resolveTypeScriptModule("@fixture/source", source, undefined, true, undefined, undefined, root)).toBeUndefined();
});

test.skipIf(!canCreateFileSymlink())("configured source resolution refuses canonical escapes through in-root paths", () => {
  for (const directoryLink of [false, true]) {
    const { root, source } = workspace();
    const outside = temporaryRoot("semctx-workspace-outside-source-link-");
    write(outside, { "external.ts": "export const external = 1;\n" });
    write(root, { "tooling/config/tsconfig/node.json": JSON.stringify({ compilerOptions: { paths: { "#external": [`${root}/internal/external.ts`] } } }) });
    if (directoryLink) symlinkSync(outside, join(root, "internal"), process.platform === "win32" ? "junction" : "dir");
    else {
      mkdirSync(join(root, "internal"));
      symlinkSync(join(outside, "external.ts"), join(root, "internal/external.ts"), "file");
    }
    expect(resolveTypeScriptModule("#external", source, undefined, true, undefined, undefined, root)).toBeUndefined();
  }
});

test.skipIf(!canCreateFileSymlink())("configured runtime companions cannot escape the repository through a sibling symlink", () => {
  const { root } = workspace();
  const outside = temporaryRoot("semctx-workspace-runtime-companion-");
  const source = `${root}/domains/registry/api/src/source.js`;
  const runtime = `${root}/domains/registry/api/src/companion.js`;
  write(root, {
    "domains/registry/api/src/source.js": 'import { value } from "./companion"; export const result = value;\n',
    "domains/registry/api/src/companion.d.ts": "export declare const value: number;\n",
  });
  write(outside, { "companion.js": "export const value = 1;\n" });
  symlinkSync(join(outside, "companion.js"), runtime, "file");
  expect(resolveTypeScriptModule("./companion", source, undefined, true, undefined, undefined, root)).toBeUndefined();
  rmSync(runtime);
  write(root, { "domains/registry/api/src/companion.js": "export const value = 0;\n" });
  expect(resolveTypeScriptModule("./companion", source, undefined, true, undefined, undefined, root)).toBe(runtime);
});

test("POSIX root node_modules markers do not prevent cached root or later workspace mapping", () => {
  const root = temporaryRoot("semctx-root-marker-mapping-");
  const target = `${root}/base.json`;
  const content = '{"compilerOptions":{"strict":true}}';
  write(root, { "base.json": content });
  const canonical = (path: string) => resolve(path).replaceAll("\\", "/");
  for (const firstMarker of [true, false]) {
    const resolver = createWorkspaceLinkResolver();
    const filesystemRoot = canonical("/");
    const consumer = "/node_modules/semctx-root-marker/consumer";
    resolver.declarations.set("fixture", { root: filesystemRoot, patterns: [] });
    resolver.links.set(`\0${filesystemRoot}`, firstMarker ? new Map([["@fixture/config", root]]) : new Map());
    resolver.links.set(`\0${canonical(consumer)}`, new Map([["@fixture/config", root]]));
    const system: ts.System = { ...ts.sys, fileExists: path => path === target,
      directoryExists: path => path === root, readFile: path => path === target ? content : undefined };
    const path = firstMarker ? "/node_modules/@fixture/config/base.json" : `${consumer}/node_modules/@fixture/config/base.json`;
    expect(workspaceLinkedSystem(system, undefined, resolver).readFile(path)).toBe(content);
  }
});

test("unobservable installed package presence cannot authorize a synthetic fallback", () => {
  const { root, source } = workspace();
  const installed = `${root}/domains/registry/api/node_modules/@fixture/config`;
  mkdirSync(installed, { recursive: true });
  const original = fs.statSync;
  const probe = spyOn(fs, "statSync").mockImplementation(((path, options) => {
    if (String(path).replaceAll("\\", "/") === installed) throw Object.assign(new Error("installed package access denied"), { code: "EACCES" });
    return original(path, options);
  }) as typeof fs.statSync);
  try {
    const resolver = createWorkspaceLinkResolver();
    expect(configurationFailures(inspectModuleConfiguration(source, root, undefined, undefined, resolver))
      .some(reason => reason.startsWith("SOURCE_CONFIGURATION_INVALID:"))).toBe(true);
    expect([...resolver.links.values()].some(links => links.has("@fixture/config"))).toBe(false);
  } finally { probe.mockRestore(); }
});

test.skipIf(!canCreateFileSymlink())("ordinary in-root inherited aliases have the same admission before and after another workspace link", () => {
  const { root, source } = workspace();
  const ordinary = `${root}/domains/ordinary/api/src/source.ts`;
  write(root, {
    "domains/ordinary/api/package.json": JSON.stringify({ name: "ordinary" }),
    "domains/ordinary/api/tsconfig.json": JSON.stringify({ extends: "./alias.json" }),
    "domains/ordinary/api/src/source.ts": "export const ordinary = 1;\n",
    "internal/base.json": JSON.stringify({ compilerOptions: { module: "ESNext" } }),
  });
  symlinkSync(join(root, "internal/base.json"), join(root, "domains/ordinary/api/alias.json"), "file");
  expect(configurationFailures(inspectModuleConfiguration(ordinary, root))).toEqual([]);
  const resolver = createWorkspaceLinkResolver();
  expect(configurationFailures(inspectModuleConfiguration(source, root, undefined, undefined, resolver))).toEqual([]);
  expect(configurationFailures(inspectModuleConfiguration(ordinary, root, undefined, undefined, resolver))).toEqual([]);
});

for (const directInheritance of [false, true]) test.skipIf(!canCreateFileSymlink())(`nested Git markers refuse ${directInheritance ? "direct inherited" : "synthetic"} member configuration targets`, () => {
  for (const marker of ["directory", "file", "dangling"] as const) {
    const { root, source } = workspace();
    const payload = JSON.stringify({ compilerOptions: { strict: true } });
    write(root, {
      "tooling/config/package.json": JSON.stringify({ name: "@fixture/config" }),
      "tooling/config/embedded/base.json": payload,
      ...(directInheritance ? { "tooling/config/tsconfig/node.json": JSON.stringify({ extends: "../embedded/base.json" }) }
        : { "domains/registry/api/tsconfig.json": JSON.stringify({ extends: "@fixture/config/embedded/base.json" }) }),
    });
    const gitMarker = join(root, "tooling/config/embedded/.git");
    if (marker === "directory") mkdirSync(gitMarker);
    else if (marker === "file") writeFileSync(gitMarker, "gitdir: missing\n");
    else symlinkSync(join(root, "missing-git-marker"), gitMarker, "file");
    const resolver = createWorkspaceLinkResolver();
    expect(configurationFailures(inspectModuleConfiguration(source, root, undefined, undefined, resolver))
      .some(reason => reason.startsWith("SOURCE_CONFIGURATION_INVALID:"))).toBe(true);
    expect([...resolver.inputs.values()]).not.toContain(payload);
    rmSync(gitMarker, { recursive: marker === "directory" });
    expect(configurationFailures(inspectModuleConfiguration(source, root))).toEqual([]);
  }
});
