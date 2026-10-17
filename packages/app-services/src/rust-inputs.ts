import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import type { SemctxConfig } from "@semantic-context/core";
import { createDiscoveryPathExclusion } from "@semantic-context/ts-analyzer";

export interface RustInputCapture {
  files: { path: string; content: string }[];
  rejected: string[];
}

export function rustEditionByPath(
  files: readonly { path: string; content: string }[],
  paths: readonly string[],
  modules: readonly { relPath: string; name: string; rustKind: string; scope: readonly string[]; attributes: readonly string[]; range: { startOffset: number; endOffset: number } }[],
): Map<string, string> {
  const selected = new Set(paths);
  const source = new Map(files.map((file) => [file.path, file.content]));
  const editions = new Map<string, string>();
  for (const manifest of files.filter((file) => file.path === "Cargo.toml" || file.path.endsWith("/Cargo.toml"))) {
    let parsed: unknown;
    try { parsed = Bun.TOML.parse(manifest.content); } catch { continue; }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const data = parsed as Record<string, unknown>;
    const crate = data["package"];
    if (crate === null || typeof crate !== "object" || Array.isArray(crate)) continue;
    const packageFields = crate as Record<string, unknown>;
    if (typeof packageFields["name"] !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(packageFields["name"])
      || typeof packageFields["version"] !== "string"
      || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(packageFields["version"])) continue;
    if (["autolib", "autobins", "autotests", "autoexamples", "autobenches"].some((flag) =>
      packageFields[flag] !== undefined && typeof packageFields[flag] !== "boolean")) continue;
    const edition = packageFields["edition"];
    if (edition !== "2018" && edition !== "2021" && edition !== "2024") continue;
    const root = manifest.path === "Cargo.toml" ? "" : manifest.path.slice(0, -"/Cargo.toml".length);
    const within = (path: string): boolean => root === "" || path.startsWith(`${root}/`);
    const target = (value: string): string | undefined => {
      const path = posix.normalize(posix.join(root, value));
      return path !== ".." && !path.startsWith("../") && within(path) && selected.has(path) ? path : undefined;
    };
    const targets = new Set<string>();
    const library = data["lib"];
    const libraryPath = library !== null && typeof library === "object" && !Array.isArray(library)
      ? (library as Record<string, unknown>)["path"] : undefined;
    const automaticDirectories = [
      ["src/bin", "autobins"], ["tests", "autotests"], ["examples", "autoexamples"], ["benches", "autobenches"],
    ] as const;
    const conventional = [
      ...(libraryPath === undefined && packageFields["autolib"] !== false ? ["src/lib.rs"] : []),
      ...(packageFields["autobins"] !== false ? ["src/main.rs"] : []),
      ...paths.filter(within).map((path) => posix.relative(root, path)).filter((path) => automaticDirectories.some(([directory, flag]) =>
        packageFields[flag] !== false && new RegExp(`^${directory}/[^/]+\\.rs$`).test(path))),
    ];
    for (const conventionalPath of conventional) {
      const path = target(conventionalPath);
      if (path !== undefined) targets.add(path);
    }
    for (const key of ["lib", "bin", "test", "example", "bench"]) {
      const entries = Array.isArray(data[key]) ? data[key] as unknown[] : [data[key]];
      for (const entry of entries) {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
        const pathValue = (entry as Record<string, unknown>)["path"];
        if (typeof pathValue !== "string") continue;
        const path = target(pathValue);
        if (path !== undefined) targets.add(path);
      }
    }
    const pending = [...targets];
    while (pending.length > 0) {
      const path = pending.pop()!;
      if (editions.has(path)) continue;
      editions.set(path, edition);
      for (const module of modules.filter((item) => item.relPath === path && item.rustKind === "mod_item")) {
        const contents = source.get(path);
        if (contents === undefined || module.attributes.some((attribute) => /^#\[\s*(?:path\s*=|cfg(?:_attr)?\s*\()/.test(attribute))
          || !/;\s*$/.test(contents.slice(module.range.startOffset, module.range.endOffset))) continue;
        const base = posix.basename(path, ".rs");
        const baseDirectory = ["lib", "main", "mod"].includes(base) ? posix.dirname(path) : posix.join(posix.dirname(path), base);
        const ancestors = module.scope.map((name) => modules.find((item) => item.relPath === path && item.rustKind === "mod_item"
          && item.name === name && item.range.startOffset < module.range.startOffset && item.range.endOffset >= module.range.endOffset));
        if (ancestors.some((ancestor) => ancestor === undefined || ancestor.attributes.some((attribute) => /^#\[\s*(?:path\s*=|cfg(?:_attr)?\s*\()/.test(attribute)))) continue;
        const directory = posix.join(baseDirectory, ...module.scope);
        const candidates = [`${directory}/${module.name}.rs`, `${directory}/${module.name}/mod.rs`]
          .filter((candidate) => within(candidate) && selected.has(candidate));
        if (candidates.length === 1) pending.push(candidates[0]!);
      }
    }
  }
  return editions;
}

export function captureRustInputs(config: SemctxConfig, retained?: ReadonlyMap<string, string>): RustInputCapture {
  const result: RustInputCapture = { files: [], rejected: [] };
  if (config.version !== 2 || config.languages.rust !== "on") return result;
  const excluded = createDiscoveryPathExclusion(config);
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const absolute = join(directory, entry.name);
      if ([".git", ".semctx", "node_modules", "target"].includes(entry.name)) continue;
      const isInput = ["Cargo.toml", "Cargo.lock", "rust-toolchain", "rust-toolchain.toml"].includes(entry.name)
        || /(?:^|\/)\.cargo\/config(?:\.toml)?$/.test(path);
      if (excluded(path, entry.isDirectory() ? "directory" : "file")) continue;
      if (entry.isSymbolicLink()) {
        if (isInput || entry.name === ".cargo") result.rejected.push(`RUST_INPUT_SYMLINK:${path}`);
        continue;
      }
      if (entry.isDirectory()) { walk(absolute, path); continue; }
      if (!isInput) continue;
      if (!lstatSync(absolute).isFile()) { result.rejected.push(`RUST_INPUT_NOT_REGULAR:${path}`); continue; }
      const content = retained === undefined ? readFileSync(absolute, "utf8") : retained.get(resolve(absolute));
      if (content === undefined) { result.rejected.push(`RUST_INPUT_NOT_RETAINED:${path}`); continue; }
      result.files.push({ path, content });
    }
  };
  walk(config.repositoryRoot, "");
  return result;
}
