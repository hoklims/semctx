import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const CONSUMER_VERSIONS = { bun: "1.4.2", pnpm: "12.9.1", turbo: "2.11.7", typescript: "7.0.2", vitest: "5.0.3" };
export const WORKSPACES = ["apps/*", "contracts/*", "design-system/*", "domains/*/*", "platform/*", "tooling/*"];
export const LEAF = "suite/domains/sample/core/value.mjs";
export const BRIDGE = "suite/platform/shared/bridge.ts";
export const ENTRY = "suite/apps/web/entry.js";
export const LEAF_SOURCE = "export function value(input) { return input + 1; }\n";

export function put(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

/** Public, synthetic sources: topology and tool pins are the only consumer-derived inputs. */
export function createConsumer(root: string): void {
  writeConsumer(root, "declaration-bearing");
}

/** Separately eligible public ESM fixture; never rewrite the original declaration witness. */
export function createEligibleConsumer(root: string): void {
  writeConsumer(root, "eligible-esm");
}

function writeConsumer(root: string, domain: "declaration-bearing" | "eligible-esm"): void {
  put(root, ".gitignore", ".semctx/\n**/node_modules/\n**/.turbo/\n**/out/\n");
  put(root, "suite/package.json", JSON.stringify({ name: "public-static-consumer", private: true, type: "module", packageManager: `pnpm@${CONSUMER_VERSIONS.pnpm}`, workspaces: WORKSPACES, scripts: { test: "vitest run", build: "turbo run build" }, devDependencies: { turbo: CONSUMER_VERSIONS.turbo, typescript: CONSUMER_VERSIONS.typescript, vitest: CONSUMER_VERSIONS.vitest } }, null, 2));
  put(root, "suite/pnpm-workspace.yaml", `packages:\n${WORKSPACES.map((pattern) => `  - '${pattern}'`).join("\n")}\n`);
  put(root, "suite/tsconfig.json", JSON.stringify({ compilerOptions: { allowJs: true, checkJs: false, strict: true, target: "ES2022", lib: ["ES2023", "DOM"], module: "ESNext", moduleResolution: "Bundler", allowImportingTsExtensions: true, skipLibCheck: true, noEmit: true, paths: { "@public/shared": ["./platform/shared/bridge.ts"] } }, include: ["**/*.ts", "**/*.js", "**/*.mjs", "**/*.jsx"] }));
  put(root, "suite/apps/web/tsconfig.json", JSON.stringify({ extends: "../../tsconfig.json", include: ["**/*.js"] }));
  for (const workspace of ["apps/web", "contracts/api", "design-system/ui", "domains/sample/core", "platform/shared", "tooling/check"]) {
    put(root, `suite/${workspace}/package.json`, JSON.stringify({ name: `@public/${workspace.replaceAll("/", "-")}`, private: true, type: "module", ...(workspace === "apps/web" ? { scripts: { build: "node ../../tooling/check/build.mjs" } } : {}) }));
  }
  put(root, "suite/turbo.json", JSON.stringify({ $schema: "https://turbo.build/schema.json", globalDependencies: ["domains/**"], tasks: { build: { outputs: ["out/**"] } } }));
  put(root, "suite/tooling/check/build.mjs", 'import { readFileSync, mkdirSync, writeFileSync } from "node:fs";\nconst source = readFileSync("../../domains/sample/core/value.mjs", "utf8");\nif (source.includes("+ 9")) throw new Error("synthetic build failure");\nmkdirSync("out", { recursive: true });\nwriteFileSync("out/result.txt", source);\n');
  put(root, LEAF, LEAF_SOURCE);
  if (domain === "declaration-bearing") put(root, "suite/domains/sample/core/value.d.mts", "export declare function value(input: number): number;\n");
  put(root, BRIDGE, 'import { value } from "../../domains/sample/core/value.mjs";\nexport function bridge(input: number): number { return value(input); }\n');
  put(root, ENTRY, 'import { bridge } from "@public/shared";\nexport function entry(input) { return bridge(input); }\n');
  put(root, `suite/contracts/api/port.${domain === "declaration-bearing" ? "cts" : "ts"}`, "export function port(input: number) { return input; }\n");
  put(root, "suite/tooling/check/check.mjs", 'import { basename } from "node:path";\nexport function check(path) { return basename(path); }\n');
  put(root, "suite/design-system/ui/component.jsx", "export function Component() { return 'public component'; }\n");
  put(root, "suite/platform/shared/async.mjs", 'export async function load() { return import("../../domains/sample/core/value.mjs"); }\n');
  put(root, "suite/domains/sample/core/value.test.ts", 'import { test, expect } from "vitest";\nimport { value } from "./value.mjs";\ntest("increments the input", () => { expect(value(1)).toBe(2); });\n');
}
