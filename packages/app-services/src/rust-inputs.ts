import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import type { SemctxConfig } from "@semantic-context/core";
import { createDiscoveryPathExclusion } from "@semantic-context/ts-analyzer";

export interface RustInputCapture {
  files: { path: string; content: string }[];
  rejected: string[];
}

export function isRustAnalysisMetadataPath(path: string): boolean {
  return ["Cargo.toml", "Cargo.lock", "rust-toolchain", "rust-toolchain.toml"].includes(posix.basename(path))
    || /(?:^|\/)\.cargo\/config(?:\.toml)?$/.test(path);
}

export function rustMembershipByPath(
  files: readonly { path: string; content: string }[],
  paths: readonly string[],
  modules: readonly { relPath: string; name: string; rustKind: string; scope: readonly string[]; attributes: readonly string[];
    range: { startOffset: number; endOffset: number; startLine: number; endLine: number } }[],
): { editionsByPath: Map<string, string>; testPaths: Set<string>;
  ambiguousPaths: Set<string>;
  moduleLinks: { parent: string; child: string; range: { startOffset: number; endOffset: number; startLine: number; endLine: number } }[] } {
  const selected = new Set(paths);
  const source = new Map(files.map((file) => [file.path, file.content]));
  const editionsByPath = new Map<string, string>();
  const testPaths = new Set<string>();
  const ambiguousPaths = new Set<string>();
  const worldsByPath = new Map<string, string>();
  const moduleLinks: { parent: string; child: string; range: { startOffset: number; endOffset: number; startLine: number; endLine: number } }[] = [];
  const manifests = files.flatMap((file) => {
    if (file.path !== "Cargo.toml" && !file.path.endsWith("/Cargo.toml")) return [];
    try {
      const data: unknown = Bun.TOML.parse(file.content);
      return data !== null && typeof data === "object" && !Array.isArray(data)
        ? [{ path: file.path, data: data as Record<string, unknown> }] : [];
    } catch { return []; }
  });
  for (const manifest of manifests) {
    const data = manifest.data;
    const crate = data["package"];
    if (crate === null || typeof crate !== "object" || Array.isArray(crate)) continue;
    const packageFields = crate as Record<string, unknown>;
    const root = manifest.path === "Cargo.toml" ? "" : manifest.path.slice(0, -"/Cargo.toml".length);
    const inheritedField = (field: "version" | "edition"): unknown => {
      const value = packageFields[field];
      if (value === null || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).length !== 1 || (value as Record<string, unknown>)["workspace"] !== true) return value;
      const matches = manifests.flatMap((candidate) => {
        const workspace = candidate.data["workspace"];
        if (workspace === null || typeof workspace !== "object" || Array.isArray(workspace)) return [];
        const workspaceRoot = candidate.path === "Cargo.toml" ? "" : candidate.path.slice(0, -"/Cargo.toml".length);
        const memberPath = posix.relative(workspaceRoot, root);
        const members = (workspace as Record<string, unknown>)["members"];
        if (memberPath !== "" && (!Array.isArray(members) || !members.includes(memberPath))) return [];
        const inherited = (workspace as Record<string, unknown>)["package"];
        return inherited !== null && typeof inherited === "object" && !Array.isArray(inherited)
          ? [(inherited as Record<string, unknown>)[field]] : [];
      });
      return matches.length === 1 ? matches[0] : undefined;
    };
    const version = inheritedField("version");
    if (typeof packageFields["name"] !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(packageFields["name"])
      || typeof version !== "string"
      || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) continue;
    if (["autolib", "autobins", "autotests", "autoexamples", "autobenches"].some((flag) =>
      packageFields[flag] !== undefined && typeof packageFields[flag] !== "boolean")) continue;
    const edition = inheritedField("edition");
    if (edition !== "2018" && edition !== "2021" && edition !== "2024") continue;
    const within = (path: string): boolean => root === "" || path.startsWith(`${root}/`);
    const target = (value: string): string | undefined => {
      if (posix.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.includes("\\")) return undefined;
      const path = posix.normalize(posix.join(root, value));
      return path !== ".." && !path.startsWith("../") && within(path) && selected.has(path) ? path : undefined;
    };
    const targets = new Map<string, { path: string; isTest: boolean; explicit: boolean }>();
    const addTarget = (path: string, isTest: boolean, world: string, explicit = false): void => {
      if (explicit) {
        const kind = world.slice(0, world.indexOf(":"));
        for (const [candidateWorld, candidate] of targets) {
          if (!candidate.explicit && candidate.path === path && candidateWorld.startsWith(`${kind}:`)) targets.delete(candidateWorld);
        }
      }
      const previous = targets.get(world);
      if (previous?.path === path) return;
      if (previous !== undefined && previous.explicit && !explicit) return;
      if (previous !== undefined && (!explicit || previous.explicit)) {
        ambiguousPaths.add(previous.path);
        ambiguousPaths.add(path);
        return;
      }
      targets.set(world, { path, isTest, explicit });
    };
    const library = data["lib"];
    const libraryPath = library !== null && typeof library === "object" && !Array.isArray(library)
      ? (library as Record<string, unknown>)["path"] : undefined;
    const automaticDirectories = [
      ["src/bin", "autobins"], ["tests", "autotests"], ["examples", "autoexamples"], ["benches", "autobenches"],
    ] as const;
    const conventional = [
      ...(libraryPath === undefined && packageFields["autolib"] !== false ? ["src/lib.rs"] : []),
      ...(packageFields["autobins"] !== false ? ["src/main.rs"] : []),
    ];
    for (const conventionalPath of conventional) {
      const path = target(conventionalPath);
      if (path !== undefined) addTarget(path, false, conventionalPath === "src/lib.rs"
        ? `lib:${(packageFields["name"] as string).replaceAll("-", "_")}` : `bin:${packageFields["name"]}`);
    }
    for (const relativePath of paths.filter(within).map((path) => posix.relative(root, path))) {
      const directory = automaticDirectories.find(([candidate, flag]) =>
        packageFields[flag] !== false && new RegExp(`^${candidate}/[^/]+(?:\\.rs|/main\\.rs)$`).test(relativePath))?.[0];
      if (directory === undefined) continue;
      const path = target(relativePath);
      if (path !== undefined) {
        const parts = relativePath.split("/");
        const name = parts.at(-1) === "main.rs" ? parts.at(-2)! : parts.at(-1)!.slice(0, -3);
        const kind = directory === "src/bin" ? "bin" : directory === "tests" ? "test" : directory === "examples" ? "example" : "bench";
        addTarget(path, kind === "test", `${kind}:${name}`);
      }
    }
    for (const key of ["lib", "bin", "test", "example", "bench"]) {
      const entries = Array.isArray(data[key]) ? data[key] as unknown[] : [data[key]];
      for (const entry of entries) {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
        const pathValue = (entry as Record<string, unknown>)["path"];
        if (typeof pathValue !== "string") continue;
        const path = target(pathValue);
        const declaredName = (entry as Record<string, unknown>)["name"];
        if (declaredName !== undefined && typeof declaredName !== "string") continue;
        if (path !== undefined) {
          const parts = pathValue.split("/");
          const inferredName = key === "lib" ? (packageFields["name"] as string).replaceAll("-", "_")
            : pathValue === "src/main.rs" ? packageFields["name"] as string
              : parts.at(-1) === "main.rs" ? parts.at(-2)! : parts.at(-1)!.replace(/\.rs$/, "");
          addTarget(path, key === "test", `${key}:${declaredName ?? inferredName}`, true);
        }
      }
    }
    const targetPaths = new Set<string>();
    for (const target of targets.values()) {
      if (targetPaths.has(target.path)) ambiguousPaths.add(target.path);
      targetPaths.add(target.path);
    }
    const pending: [string, boolean, string][] = [...targets].map(([world, target]) =>
      [target.path, target.isTest, `${manifest.path}:${world}`]);
    const processed = new Set<string>();
    while (pending.length > 0) {
      const [path, isTest, world] = pending.pop()!;
      const previousWorld = worldsByPath.get(path);
      if (previousWorld !== undefined && previousWorld !== world) ambiguousPaths.add(path);
      worldsByPath.set(path, world);
      const context = `${path}:${world}`;
      if (processed.has(context)) continue;
      processed.add(context);
      if (!editionsByPath.has(path)) editionsByPath.set(path, edition);
      if (isTest) testPaths.add(path);
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
        if (candidates.length === 1) {
          pending.push([candidates[0]!, isTest, world]);
          moduleLinks.push({ parent: path, child: candidates[0]!, range: module.range });
        }
      }
    }
  }
  return { editionsByPath, testPaths, ambiguousPaths, moduleLinks };
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
      const isInput = isRustAnalysisMetadataPath(path);
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
