import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { RustNavigationConfigSchema, type RustNavigationConfig } from "@semantic-context/core";
import { execFileSyncWithinBudget } from "../../../plugins/shared/hooks/process-budget.mjs";
import { RustSourceSchema, type RustExtraction, type RustSource } from "./model";
import { RustLspClient } from "./lsp";

const PositionSchema = z.object({ line: z.number().int().nonnegative(), character: z.number().int().nonnegative() });
const RangeSchema = z.object({ start: PositionSchema, end: PositionSchema });
const LocationSchema = z.object({ uri: z.string(), range: RangeSchema });
const LocationLinkSchema = z.object({ targetUri: z.string(), targetRange: RangeSchema, targetSelectionRange: RangeSchema });
const DefinitionSchema = z.union([z.null(), LocationSchema, z.array(LocationSchema), z.array(LocationLinkSchema)]);
const InitializeResponseSchema = z.object({
  capabilities: z.object({ positionEncoding: z.literal("utf-16") }),
  serverInfo: z.object({ version: z.enum([
    "0.3.3081-standalone",
    "0.3.3081-standalone (2ad81e72b7 2026-10-11)",
  ]) }),
});
const MetadataSchema = z.object({ packages: z.array(z.object({
  manifest_path: z.string(), edition: z.enum(["2018", "2021", "2024"]),
  targets: z.array(z.object({ src_path: z.string() })),
  dependencies: z.array(z.object({ path: z.string().nullable().optional(), source: z.string().nullable() })),
})), workspace_members: z.array(z.string()) });

function digest(bytes: string | Uint8Array): string { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }

export function parseRustAnalyzerInitializeResponse(value: unknown): void {
  InitializeResponseSchema.parse(value);
}

function directoryDigest(directory: string): string {
  const entries: [string, string][] = [];
  const walk = (path: string): void => {
    for (const item of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const child = join(path, item.name);
      if (item.isSymbolicLink()) throw new Error("RUST_TOOLCHAIN_SYMLINK");
      if (item.isDirectory()) walk(child);
      else if (item.isFile()) entries.push([relative(directory, child).replaceAll("\\", "/"), digest(readFileSync(child))]);
      else throw new Error("RUST_TOOLCHAIN_NOT_REGULAR");
    }
  };
  walk(directory);
  if (entries.length === 0) throw new Error("RUST_TOOLCHAIN_EMPTY");
  return digest(JSON.stringify(entries));
}

function confined(root: string, path: string): string {
  const local = relative(root, path).replaceAll("\\", "/");
  if (local === ".." || local.startsWith("../") || isAbsolute(local)) throw new Error("RUST_PATH_OUTSIDE_REPOSITORY");
  return local;
}

export function rustToolchainIdentity(config: RustNavigationConfig): string {
  if (!isAbsolute(config.rustAnalyzerPath) || !isAbsolute(config.toolchainRoot)) throw new Error("RUST_TOOL_PATH_NOT_ABSOLUTE");
  const executable = process.platform === "win32" ? ".exe" : "";
  const analyzerDigest = digest(readFileSync(config.rustAnalyzerPath));
  if (analyzerDigest !== `sha256:${config.rustAnalyzerSha256}`) throw new Error("RUST_ANALYZER_DIGEST_MISMATCH");
  const targetLibrary = join(config.toolchainRoot, "lib", "rustlib", config.target, "lib");
  if (!existsSync(targetLibrary)) throw new Error("RUST_TARGET_UNAVAILABLE");
  return digest(JSON.stringify({ analyzerDigest,
    rustc: digest(readFileSync(join(config.toolchainRoot, "bin", `rustc${executable}`))),
    cargo: digest(readFileSync(join(config.toolchainRoot, "bin", `cargo${executable}`))),
    sources: directoryDigest(join(config.toolchainRoot, "lib", "rustlib", "src", "rust", "library")),
    target: directoryDigest(targetLibrary),
  }));
}

export async function resolveRustNavigation(input: {
  files: readonly RustSource[]; metadata: readonly RustSource[]; extraction: RustExtraction; config: RustNavigationConfig;
}): Promise<{ relations: { queryIndex: number; symbolIndex: number }[]; unresolved: { queryIndex: number; reason: string }[]; identity: string }> {
  const config = RustNavigationConfigSchema.parse(input.config);
  const identity = rustToolchainIdentity(config);
  const result = { relations: [] as { queryIndex: number; symbolIndex: number }[], unresolved: [] as { queryIndex: number; reason: string }[], identity };
  if (input.extraction.limitations.some((limitation) => limitation.kind === "glob-import")) {
    result.unresolved = input.extraction.queries.map((_, queryIndex) => ({ queryIndex, reason: "RUST_GLOB_IMPORT_PROFILE_REFUSED" }));
    return result;
  }
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "semctx-rust-navigation-")));
  let client: RustLspClient | undefined;
  try {
    const root = join(directory, "workspace");
    mkdirSync(root);
    const retained = new Map<string, string>();
    for (const file of [...input.files, ...input.metadata]) {
      RustSourceSchema.parse(file);
      if (retained.has(file.relPath)) throw new Error("RUST_DUPLICATE_SOURCE");
      if (/(?:^|\/)\.cargo\//.test(file.relPath) || /(?:^|\/)rust-toolchain(?:\.toml)?$/.test(file.relPath)) {
        throw new Error("RUST_CARGO_CONFIGURATION_UNSUPPORTED");
      }
      const path = resolve(root, file.relPath);
      confined(root, path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file.source);
      retained.set(file.relPath, file.source);
    }
    const manifests = input.metadata.filter((file) => /(?:^|\/)Cargo\.toml$/.test(file.relPath));
    if (manifests.length === 0) throw new Error("RUST_MANIFEST_MISSING");
    for (const manifest of manifests) validateManifestPaths(root, manifest, retained);
    const roots = manifests.filter((manifest) => !manifests.some((other) => other !== manifest
      && (dirname(other.relPath) === "." || manifest.relPath.startsWith(`${dirname(other.relPath)}/`))));
    const executable = process.platform === "win32" ? ".exe" : "";
    const bin = join(config.toolchainRoot, "bin");
    const environment: NodeJS.ProcessEnv = {
      PATH: `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
      HOME: directory, USERPROFILE: directory, CARGO_HOME: join(directory, "cargo-home"),
      XDG_CONFIG_HOME: join(directory, "config"), CARGO_NET_OFFLINE: "true", CARGO_TARGET_DIR: join(directory, "target"),
      RUSTC: join(bin, `rustc${executable}`),
      ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
      ...(process.env.TEMP === undefined ? {} : { TEMP: process.env.TEMP }),
    };
    const rustcVersion = execFileSyncWithinBudget(environment.RUSTC!, ["--version"], { encoding: "utf8", timeout: 5_000, env: environment, cwd: root });
    if (!rustcVersion.startsWith("rustc 1.98.1 ")) throw new Error("RUST_TOOLCHAIN_VERSION_UNSUPPORTED");
    for (const manifest of roots) {
      const raw = execFileSyncWithinBudget(join(bin, `cargo${executable}`), ["metadata", "--offline", "--format-version=1", "--manifest-path", join(root, manifest.relPath),
        "--filter-platform", config.target, ...(config.features.length ? ["--features", config.features.join(",")] : [])],
      { encoding: "utf8", timeout: Math.min(config.budgetMs, 15_000), env: environment, cwd: root });
      const metadata = MetadataSchema.parse(JSON.parse(raw));
      if (metadata.packages.length === 0 || metadata.workspace_members.length === 0) throw new Error("RUST_WORKSPACE_EMPTY");
      for (const crate of metadata.packages) {
        confined(root, crate.manifest_path);
        for (const target of crate.targets) {
          const path = confined(root, target.src_path);
          if (!retained.has(path)) throw new Error(`RUST_TARGET_NOT_SELECTED:${path}`);
        }
        for (const dependency of crate.dependencies) {
          if (dependency.source !== null || dependency.path == null) throw new Error("RUST_EXTERNAL_DEPENDENCY_UNQUALIFIED");
          confined(root, dependency.path);
        }
      }
    }
    const sysrootSource = join(directory, "sysroot-source");
    cpSync(join(config.toolchainRoot, "lib", "rustlib", "src", "rust", "library"), sysrootSource, { recursive: true });
    client = new RustLspClient([config.rustAnalyzerPath], { cwd: root, budgetMs: config.budgetMs, env: environment });
    parseRustAnalyzerInitializeResponse(await client.request("initialize", {
      processId: null, rootUri: pathToFileURL(root).href,
      capabilities: { experimental: { serverStatusNotification: true }, general: { positionEncodings: ["utf-16"] } },
      initializationOptions: { linkedProjects: roots.map((manifest) => join(root, manifest.relPath)),
        cargo: { buildScripts: { enable: false }, sysroot: config.toolchainRoot, sysrootSrc: sysrootSource, target: config.target, features: config.features },
        cfg: { setTest: true }, procMacro: { enable: false }, checkOnSave: false },
    }));
    client.notify("initialized", {});
    await client.waitUntilReady();
    for (const file of input.files) client.notify("textDocument/didOpen", { textDocument: { uri: pathToFileURL(join(root, file.relPath)).href, languageId: "rust", version: 1, text: file.source } });
    for (const [queryIndex, query] of input.extraction.queries.entries()) {
      const raw = DefinitionSchema.parse(await client.request("textDocument/definition", {
        textDocument: { uri: pathToFileURL(join(root, query.relPath)).href },
        position: { line: query.target.startLine - 1, character: query.target.startColumn - 1 },
      }));
      const locations = raw === null ? [] : Array.isArray(raw) ? raw : [raw];
      const matches = new Set<number>();
      let outside = false;
      for (const location of locations) {
        const uri = "uri" in location ? location.uri : location.targetUri;
        const range = "range" in location ? location.range : location.targetSelectionRange;
        let path: string;
        try { path = confined(root, fileURLToPath(uri)); }
        catch { outside = true; continue; }
        for (const [symbolIndex, symbol] of input.extraction.symbols.entries()) {
          if (symbol.relPath === path && symbol.nameRange.startLine - 1 === range.start.line
            && symbol.nameRange.startColumn - 1 === range.start.character && symbol.nameRange.endLine - 1 === range.end.line
            && symbol.nameRange.endColumn - 1 === range.end.character) matches.add(symbolIndex);
        }
      }
      if (!outside && locations.length === 1 && matches.size === 1) result.relations.push({ queryIndex, symbolIndex: [...matches][0]! });
      else result.unresolved.push({ queryIndex, reason: outside ? "RUST_EXTERNAL_TARGET" : locations.length > 1 || matches.size > 1 ? "RUST_AMBIGUOUS_TARGET" : "RUST_TARGET_UNRESOLVED" });
    }
    for (const [path, content] of retained) if (readFileSync(join(root, path), "utf8") !== content) throw new Error("RUST_SOURCE_DRIFT");
    if (rustToolchainIdentity(config) !== identity) throw new Error("RUST_TOOLCHAIN_DRIFT");
    return result;
  } finally {
    try { await client?.close(); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  }
}

function validateManifestPaths(root: string, manifest: RustSource, retained: ReadonlyMap<string, string>): void {
  const parsed: unknown = Bun.TOML.parse(manifest.source);
  const inspect = (value: unknown, keys: string[]): void => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return;
    for (const [key, item] of Object.entries(z.record(z.unknown()).parse(value))) {
      if (keys.join(".") === "workspace" && ["members", "default-members", "exclude"].includes(key)) {
        const paths = z.array(z.string()).parse(item);
        for (const path of paths) confined(root, resolve(root, dirname(manifest.relPath), path));
      }
      if (keys.join(".") === "package" && key === "workspace" && typeof item === "string") {
        confined(root, resolve(root, dirname(manifest.relPath), item));
      }
      if (["git", "registry", "registry-index"].includes(key)) throw new Error("RUST_EXTERNAL_DEPENDENCY_UNQUALIFIED");
      if (key === "path" && typeof item === "string") {
        const path = resolve(root, dirname(manifest.relPath), item);
        const local = confined(root, path);
        if (!retained.has(local) && !retained.has(`${local}/Cargo.toml`)) throw new Error(`RUST_PATH_NOT_SELECTED:${local}`);
        if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("RUST_INPUT_SYMLINK");
      }
      if (["dependencies", "dev-dependencies", "build-dependencies"].includes(key)) {
        if (item === null || typeof item !== "object" || Array.isArray(item)) throw new Error("RUST_DEPENDENCIES_INVALID");
        for (const dependency of Object.values(z.record(z.unknown()).parse(item))) {
          if (dependency === null || typeof dependency !== "object" || Array.isArray(dependency)
            || !("path" in dependency || "workspace" in dependency && dependency.workspace === true)) throw new Error("RUST_EXTERNAL_DEPENDENCY_UNQUALIFIED");
        }
      }
      inspect(item, [...keys, key]);
    }
  };
  inspect(parsed, []);
}
