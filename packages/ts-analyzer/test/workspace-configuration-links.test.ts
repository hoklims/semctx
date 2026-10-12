import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inspectModuleConfiguration } from "../src/javascript-diagnostics";
import { resolveTypeScriptModule } from "../src/ts-symbols";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

const CONFIG_MEMBER = {
  "tooling/config/package.json": JSON.stringify({
    name: "@fixture/config",
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
  const root = mkdtempSync(join(tmpdir(), "semctx-workspace-links-")).replaceAll("\\", "/");
  roots.push(root);
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
  const parent = mkdtempSync(join(tmpdir(), "semctx-workspace-boundary-")).replaceAll("\\", "/");
  roots.push(parent);
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
