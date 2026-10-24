import ts from "typescript";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";

const [baselineRoot, inputPath, outputPath, workRoot] = process.argv.slice(2);
if (!baselineRoot || !inputPath || !outputPath || !workRoot) throw new Error("expected baseline inputs output fresh-work-root");
if (ts.version !== "5.9.3") throw new Error("oracle requires TypeScript 5.9.3");
const sourcePath = resolve(baselineRoot, "packages/ts-analyzer/src/ts-symbols.ts");
const baseline = await import(sourcePath);
const inputBytes = await readFile(inputPath);
const inputs = JSON.parse(inputBytes.toString());
await mkdir(workRoot);
const units = [];
for (const [index, input] of inputs.units.entries()) {
  const root = resolve(workRoot, `unit-${index}`);
  await mkdir(root);
  for (const [path, text] of Object.entries(input.files)) {
    const absolute = resolve(root, path);
    if (!absolute.startsWith(root + "/")) throw new Error("input leaves its root");
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, text);
  }
  const roots = input.roots.map(path => {
    const absolute = resolve(root, path);
    if (!absolute.startsWith(root + "/")) throw new Error("root leaves its workspace");
    return absolute;
  });
  const expected = await baseline.extractTypeScriptParallel(roots, root, input.workers);
  units.push({ ...input, expected });
}
await writeFile(outputPath, JSON.stringify({
  schemaVersion: 1,
  oracle: {
    baseline: "3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b",
    typescript: ts.version,
    sourceSha256: createHash("sha256").update(await readFile(sourcePath)).digest("hex"),
    inputsSha256: createHash("sha256").update(inputBytes).digest("hex"),
  },
  units,
}, null, 2) + "\n");
