import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildPortableBundle,
  CLI_BUNDLE_SPEC,
  INDEX_WORKER_BUNDLE_SPEC,
  RUST_WORKER_BUNDLE_SPEC,
  rustParserAssets,
  writePortableTypeScriptLibs,
} from "./build-plugin-runtime";

const root = resolve(import.meta.dir, "..");
const dist = resolve(root, "apps/cli/dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
await Bun.write(resolve(dist, "index.js"), await buildPortableBundle(CLI_BUNDLE_SPEC));
await Bun.write(
  resolve(dist, INDEX_WORKER_BUNDLE_SPEC.name),
  await buildPortableBundle(INDEX_WORKER_BUNDLE_SPEC),
);
await Bun.write(resolve(dist, RUST_WORKER_BUNDLE_SPEC.name), await buildPortableBundle(RUST_WORKER_BUNDLE_SPEC));
for (const [path, bytes] of rustParserAssets()) {
  const output = resolve(dist, path);
  mkdirSync(resolve(output, ".."), { recursive: true });
  await Bun.write(output, bytes);
}
writePortableTypeScriptLibs(dist);

if (process.env["npm_lifecycle_event"] !== "prepack") {
  process.stdout.write("built portable npm CLI bundle with colocated TypeScript libraries\n");
}
