import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const outputs = [
  resolve(root, "plugins/claude-code/dist/semctx-mcp.js"),
  resolve(root, "plugins/semctx-control/dist/semctx-mcp.js"),
];
const check = process.argv.includes("--check");
const typescriptEntrypoint = Bun.resolveSync("typescript", root);
const typescriptLibSource = dirname(typescriptEntrypoint);
const typescriptLibs = readdirSync(typescriptLibSource)
  .filter((name) => name.startsWith("lib") && name.endsWith(".d.ts"))
  .sort();

const result = await Bun.build({
  entrypoints: ["packages/mcp-server/src/index.ts"],
  root,
  target: "bun",
  minify: true,
  packages: "bundle",
  write: false,
});

if (!result.success || result.outputs.length !== 1) {
  for (const log of result.logs) process.stderr.write(`${log}\n`);
  throw new Error("failed to build the semctx plugin runtime");
}

const generated = await result.outputs[0]!.text();
const absoluteTypeScriptPrelude = `var __dirname=${JSON.stringify(typescriptLibSource)},__filename=${JSON.stringify(typescriptEntrypoint)};`;
const portableTypeScriptPrelude = 'var __dirname=import.meta.dir+"/typescript-lib",__filename=__dirname+"/typescript.js";';
const preludeCount = generated.split(absoluteTypeScriptPrelude).length - 1;
if (preludeCount !== 1) {
  throw new Error(`expected one bundled TypeScript path prelude, found ${preludeCount}`);
}
const portable = generated.replace(absoluteTypeScriptPrelude, portableTypeScriptPrelude);
const escapedRoot = JSON.stringify(root).slice(1, -1);
if (portable.includes(escapedRoot)) {
  throw new Error("generated plugin runtime still contains the build checkout path");
}
const bytes = new TextEncoder().encode(portable);

function filesEqual(left: string, right: string): boolean {
  const leftBytes = readFileSync(left);
  const rightBytes = readFileSync(right);
  return leftBytes.length === rightBytes.length && leftBytes.every((value, index) => value === rightBytes[index]);
}

for (const output of outputs) {
  const typescriptLibOutput = resolve(dirname(output), "typescript-lib");
  if (check) {
    if (!existsSync(output)) throw new Error(`missing generated plugin runtime: ${output}`);
    const current = readFileSync(output);
    const fresh = current.length === bytes.length && current.every((value, index) => value === bytes[index]);
    if (!fresh) throw new Error(`stale generated plugin runtime: ${output}; run 'bun run plugin:build'`);
    if (!existsSync(typescriptLibOutput)) {
      throw new Error(`missing generated TypeScript libraries: ${typescriptLibOutput}`);
    }
    const currentLibs = readdirSync(typescriptLibOutput).sort();
    if (currentLibs.join("\n") !== typescriptLibs.join("\n")) {
      throw new Error(`stale generated TypeScript library set: ${typescriptLibOutput}; run 'bun run plugin:build'`);
    }
    for (const lib of typescriptLibs) {
      if (!filesEqual(resolve(typescriptLibSource, lib), resolve(typescriptLibOutput, lib))) {
        throw new Error(`stale generated TypeScript library: ${resolve(typescriptLibOutput, lib)}; run 'bun run plugin:build'`);
      }
    }
    continue;
  }
  mkdirSync(dirname(output), { recursive: true });
  await Bun.write(output, bytes);
  rmSync(typescriptLibOutput, { recursive: true, force: true });
  mkdirSync(typescriptLibOutput, { recursive: true });
  for (const lib of typescriptLibs) {
    copyFileSync(resolve(typescriptLibSource, lib), resolve(typescriptLibOutput, lib));
  }
}

process.stdout.write(
  `${check ? "verified" : "built"} byte-identical plugin runtimes (${bytes.length} bytes, ${typescriptLibs.length} TypeScript libraries)\n`,
);
