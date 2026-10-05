import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  codexPluginManifestIdentity,
  resolveCodexWindowsProgramData,
  type CodexWindowsQueryFailureReason,
  type PluginDeliveryReportV2,
} from "../src/plugin-delivery";
import type { InstallReport } from "../../../apps/cli/src/commands/install";
import packageJson from "../../../apps/cli/package.json";

type RawHomeSource = "HOME" | "USERPROFILE" | "CODEX_HOME" | "OS_HOME";
interface ProductionObservation {
  report: PluginDeliveryReportV2;
  rawHits: number;
  phase: number;
  cachePath: string;
  nativeCalls: string[];
  nativeOptions: { command: string[]; timeout: number | null; maxBuffer: number | null }[];
  cacheManifestOpens: number;
}
interface InstallObservation extends Omit<ProductionObservation, "report"> { report: InstallReport }
type SystemPolicy = "absent" | "disabled" | "unresolved" | "root-drift" | "raw-root-drift"
  | "temp-root" | "query-nonzero" | "query-timeout" | "query-output-limit" | "query-stderr"
  | "query-output-shape" | "query-temp-drift" | "query-profile-drift" | "query-decode" | "query-path-shape";
type FallbackFault = "safe" | "drift" | "link" | "regular";
interface ProductionJsonFixture {
  marketplace: string;
  dryRun?: boolean;
  artifacts?: { sidecar?: string | number[]; snapshotManifest?: string; payloadManifest?: string;
    configuredRef?: string | null; configuredSparse?: string[]; localSidecar?: boolean; fixedInventory?: boolean;
    unregistered?: boolean; orphanCache?: boolean; projectConfig?: string; userConfig?: string;
    matchingBundles?: boolean; localCache?: boolean; payloadAfterInventory?: string; gitRef?: string;
    cachePeers?: { version: string; before: boolean; bundlePrefix: string }[];
    checkout?: { source: string; ref: string; revision: string; topLevel?: "self" | "parent" | "relative";
      topLevelFault?: "timeout" | "truncated" } };
  unrelatedCache?: { version: string; declaredVersion?: string; pluginName?: string };
  recovery?: { snapshotManifest?: string; cacheManifest?: string; sidecarAfterAdd?: string;
    configBeforeAdd?: string; configAfterAdd?: string; success?: boolean;
    afterNativeList?: "disable" | "higher-cache" };
  transport?: { executable: string; mode: string; sentinel: string; advanceAfterMarketplace?: number;
    timedOutMutation?: boolean };
  unsupportedLayer?: { location: "system" | "cwd" | "ancestor"; text: string };
}

function productionStatus(source: RawHomeSource, drift = false, orphan = false,
  systemPolicy: SystemPolicy = "absent"): ProductionObservation {
  return productionFixture(source, drift, orphan, systemPolicy) as ProductionObservation;
}

function productionInstall(fault: FallbackFault): InstallObservation {
  return productionFixture("OS_HOME", fault === "drift", false, "absent", "install", fault) as InstallObservation;
}

/** Module replacements stay in a child process; every filesystem observation is synthetic. */
function productionFixture(source: RawHomeSource, drift: boolean, orphan: boolean,
  systemPolicy: SystemPolicy, caller = "status", fallbackFault: FallbackFault = "safe",
  jsonFixture?: ProductionJsonFixture,
): ProductionObservation | InstallObservation {
  const moduleUrl = pathToFileURL(join(import.meta.dir, "..", "src", "plugin-delivery.ts")).href;
  const installUrl = pathToFileURL(join(import.meta.dir, "../../../apps/cli/src/commands/install.ts")).href;
  const argsUrl = pathToFileURL(join(import.meta.dir, "../../../apps/cli/src/args.ts")).href;
  const root = resolve(parse(process.cwd()).root, "semctx-production-boundary-fixture");
  // Status/order cases keep their fixed version corpus; installation tracks the release SSOT.
  const fixtureVersion = caller === "install" ? packageJson.version : "0.3.7";
  const [major, minor, patch] = fixtureVersion.split(".").map(Number);
  const newerFixtureVersion = `${major}.${minor}.${patch! + 1}`;
  const program = `
    import { mock } from "bun:test";
    import * as fs from "node:fs";
    import * as os from "node:os";
    import { basename, dirname, join, resolve, sep } from "node:path";
    const originalFs = { ...fs }, originalOs = { ...os };
    const root = ${JSON.stringify(root)}, source = ${JSON.stringify(source)};
    const drift = ${JSON.stringify(drift)}, orphan = ${JSON.stringify(orphan)};
    const systemPolicy = ${JSON.stringify(systemPolicy)}, caller = ${JSON.stringify(caller)};
    const fallbackFault = ${JSON.stringify(fallbackFault)};
    const jsonFixture = ${JSON.stringify(jsonFixture ?? null)};
    const fixtureVersion = ${JSON.stringify(fixtureVersion)}, newerFixtureVersion = ${JSON.stringify(newerFixtureVersion)};
    const gitRoot = join(root, "repo"), home = join(root, "profile");
    const repo = jsonFixture?.unsupportedLayer?.location === "ancestor" ? join(gitRoot, "child") : gitRoot;
    const osHome = join(root, "os-home"), cancelled = join(root, "cancelled");
    const knownFolder = join(root, "known-program-data"), systemCancelled = join(root, "system-cancelled");
    const rawHome = cancelled + sep + ".." + sep + "os-home";
    const rawCodexHome = cancelled + sep + ".." + sep + "profile";
    const codexHome = source === "OS_HOME" ? join(osHome, ".codex") : home;
    const cachePath = join(codexHome, "plugins", "cache", "semctx-stable", "semctx-control", "local");
    const ownedCodex = join(root, "bin", process.platform === "win32" ? "codex.exe" : "codex");
    const dirs = new Set(), files = new Map(), identities = new Map();
    let identity = 1, phase = 0, systemPhase = 0, windowsQueryPhase = 0, rawHits = 0, nextDescriptor = 100;
    let cacheManifestOpens = 0;
    const selectedCache = join(codexHome, "plugins", "cache", "semctx-stable", "semctx-control",
      jsonFixture?.artifacts?.localCache ? "local" : fixtureVersion);
    const nativeCalls = [], nativeOptions = [], descriptors = new Map();
    const originalSpawnSync = Bun.spawnSync, originalNow = Date.now;
    let nativeClockAdvance = 0;
    Date.now = () => originalNow() + nativeClockAdvance;
    const runOwnedHost = (argv, options) => originalSpawnSync(
      [jsonFixture.transport.executable, ...argv.slice(1)], {
        ...options, cwd: dirname(jsonFixture.transport.executable),
        env: { ...(options.env ?? process.env), SEMCTX_NATIVE_MODE: jsonFixture.transport.mode,
          SEMCTX_NATIVE_SENTINEL: jsonFixture.transport.sentinel,
          SEMCTX_NATIVE_SNAPSHOT: join(codexHome, ".tmp", "marketplaces", "semctx-stable", "plugins", "semctx-control") },
      });
    const addDirectory = (path) => {
      let current = resolve(path);
      for (;;) {
        dirs.add(current);
        if (!identities.has(current)) identities.set(current, identity++);
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
      }
    };
    const addFile = (path, text) => {
      addDirectory(dirname(path));
      files.set(path, Buffer.from(text));
      identities.set(path, identity++);
    };
    for (const path of [repo, home, osHome, cancelled, codexHome, knownFolder, systemCancelled, join(root, "owned-temp"),
      join(root, "program-data")]) addDirectory(path);
    if (process.platform === "win32") addFile(ownedCodex, "owned synthetic Codex executable");
    if (process.platform !== "win32") addDirectory("/etc");
    addFile(join(gitRoot, ".git", "HEAD"), "ref: refs/heads/main\\n");
    if (systemPolicy === "disabled") addFile(join(knownFolder, "OpenAI", "Codex", "config.toml"),
      "[features]\\nplugins = false\\n");
    if (orphan) addFile(join(cachePath, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "semctx-control", version: fixtureVersion }));
    if (jsonFixture !== null) {
      const marketplace = join(codexHome, ".tmp", "marketplaces", "semctx-stable");
      addDirectory(join(marketplace, "plugins", "semctx-control"));
      addFile(join(codexHome, "config.toml"),
        "[marketplaces.semctx-stable]\\nsource_type = 'git'\\nsource = 'hoklims/semctx'\\nref = 'stable'\\n");
      addFile(join(marketplace, ".agents", "plugins", "marketplace.json"), jsonFixture.marketplace);
      if (jsonFixture.artifacts !== undefined) {
        const addCachePeer = (peer) => {
          const peerRoot = join(codexHome, "plugins", "cache", "semctx-stable", "semctx-control", peer.version);
          addFile(join(peerRoot, ".codex-plugin", "plugin.json"),
            JSON.stringify({ name: "semctx-control", version: peer.version }));
          for (const bundle of ["semctx-index-worker.js", "semctx-mcp.js", "semctx-shared.js", "semctx.js"]) {
            addFile(join(peerRoot, "dist", bundle), peer.bundlePrefix + bundle);
          }
        };
        for (const peer of jsonFixture.artifacts.cachePeers ?? []) if (peer.before) addCachePeer(peer);
        addFile(join(codexHome, "config.toml"),
          jsonFixture.artifacts.unregistered ? "" : "[marketplaces.semctx-stable]\\nsource_type = " + (jsonFixture.artifacts.localSidecar ? "'local'" : "'git'")
          + "\\nsource = " + JSON.stringify(jsonFixture.artifacts.localSidecar ? marketplace : "hoklims/semctx") + "\\n"
          + (jsonFixture.artifacts.configuredRef === null || jsonFixture.artifacts.localSidecar ? ""
            : "ref = " + JSON.stringify(jsonFixture.artifacts.configuredRef ?? "stable") + "\\n")
          + "sparse_paths = " + JSON.stringify(jsonFixture.artifacts.configuredSparse ?? []) + "\\n"
          + "[plugins.'semctx-control@semctx-stable']\\nenabled = true\\n");
        const versionedCache = selectedCache;
        if (!jsonFixture.artifacts.unregistered || jsonFixture.artifacts.orphanCache) {
          addFile(join(versionedCache, ".codex-plugin", "plugin.json"), jsonFixture.artifacts.payloadManifest
            ?? JSON.stringify({ name: "semctx-control", version: fixtureVersion }));
        }
        addFile(join(marketplace, "plugins", "semctx-control", ".codex-plugin", "plugin.json"),
          jsonFixture.artifacts.snapshotManifest ?? JSON.stringify({ name: "semctx-control", version: fixtureVersion }));
        if (jsonFixture.artifacts.sidecar !== undefined) addFile(join(marketplace, ".codex-marketplace-install.json"),
          jsonFixture.artifacts.sidecar);
        if (jsonFixture.artifacts.localSidecar) addFile(join(marketplace, ".codex-marketplace-install.json"),
          JSON.stringify({ source_type: "local", source: marketplace, ref_name: null, sparse_paths: [], revision: "" }));
        if (jsonFixture.artifacts.matchingBundles) {
          for (const bundle of ["semctx-index-worker.js", "semctx-mcp.js", "semctx-shared.js", "semctx.js"]) {
            addFile(join(marketplace, "plugins", "semctx-control", "dist", bundle), "same bundle: " + bundle);
            addFile(join(versionedCache, "dist", bundle), "same bundle: " + bundle);
          }
        }
        for (const peer of jsonFixture.artifacts.cachePeers ?? []) if (!peer.before) addCachePeer(peer);
        if (jsonFixture.artifacts.projectConfig !== undefined) {
          const user = jsonFixture.artifacts.userConfig ?? files.get(join(codexHome, "config.toml")).toString("utf8");
          addFile(join(codexHome, "config.toml"), user + "\\n[projects." + JSON.stringify(repo)
            + "]\\ntrust_level = 'trusted'\\n");
          addFile(join(repo, ".codex", "config.toml"), jsonFixture.artifacts.projectConfig);
        }
      }
      if (jsonFixture.recovery !== undefined) {
        if (jsonFixture.artifacts?.unregistered) addFile(join(marketplace, ".codex-marketplace-install.json"),
          JSON.stringify({ source_type: "git", source: "hoklims/semctx", ref_name: "stable", sparse_paths: [], revision: "1".repeat(40) }));
        addFile(join(codexHome, "config.toml"),
          jsonFixture.recovery.configBeforeAdd ?? (jsonFixture.artifacts?.unregistered ? ""
            : "[marketplaces.semctx-stable]\\nsource_type = 'git'\\nsource = 'hoklims/semctx'\\nref = 'stable'\\n"
              + "[plugins.'semctx-control@semctx-stable']\\nenabled = true\\n"));
        if (!jsonFixture.artifacts?.unregistered) addFile(join(codexHome, "plugins", "cache", "semctx-stable", "semctx-control", "0.3.6", ".codex-plugin", "plugin.json"),
          JSON.stringify({ name: "semctx-control", version: "0.3.6" }));
        addFile(join(marketplace, "plugins", "semctx-control", ".codex-plugin", "plugin.json"),
          jsonFixture.recovery.snapshotManifest ?? JSON.stringify({ name: "semctx-control", version: fixtureVersion }));
        for (const bundle of ["semctx-index-worker.js", "semctx-mcp.js", "semctx-shared.js", "semctx.js"]) {
          addFile(join(marketplace, "plugins", "semctx-control", "dist", bundle), "same bundle: " + bundle);
        }
      }
      if (jsonFixture.unrelatedCache !== undefined) {
        const otherRoot = join(codexHome, ".tmp", "marketplaces", "other");
        addDirectory(join(otherRoot, "plugins", "helper"));
        addFile(join(otherRoot, ".agents", "plugins", "marketplace.json"), JSON.stringify({ name: "other",
          plugins: [{ name: "helper", source: { source: "local", path: "./plugins/helper" } }] }));
        addFile(join(codexHome, "plugins", "cache", "other", "helper", jsonFixture.unrelatedCache.version,
          ".codex-plugin", "plugin.json"), JSON.stringify({ name: jsonFixture.unrelatedCache.pluginName ?? "helper",
          version: jsonFixture.unrelatedCache.declaredVersion ?? jsonFixture.unrelatedCache.version }));
        addFile(join(codexHome, "config.toml"), files.get(join(codexHome, "config.toml")).toString("utf8")
          + "\\n[marketplaces.other]\\nsource_type = 'git'\\nsource = 'someone/other'\\n"
          + "[plugins.'helper@other']\\nenabled = true\\n");
      }
      if (jsonFixture.unsupportedLayer !== undefined) {
        const location = jsonFixture.unsupportedLayer.location;
        const target = location === "system" ? (process.platform === "win32"
          ? join(knownFolder, "OpenAI", "Codex", "config.toml") : "/etc/codex/config.toml")
          : location === "cwd" ? join(repo, "config.toml") : join(gitRoot, ".codex", "config.toml");
        addFile(target, jsonFixture.unsupportedLayer.text);
        if (location !== "system") addFile(join(codexHome, "config.toml"), files.get(join(codexHome, "config.toml")).toString("utf8")
          + "\\n[projects." + JSON.stringify(gitRoot) + "]\\ntrust_level = 'trusted'\\n");
      }
    }
    const missing = () => Object.assign(new Error("synthetic absence"), { code: "ENOENT" });
    const stat = (path) => {
      const physical = resolve(String(path));
      // The home marketplace is the last part of a snapshot. Swap its cancelled ancestor
      // only after that snapshot has captured the selected raw home traversal.
      if (drift && (source === "HOME" || source === "USERPROFILE")
        && physical === join(osHome, ".cursor-plugin")) phase = 1;
      if ((systemPolicy === "root-drift" || systemPolicy === "raw-root-drift")
        && physical === join(osHome, ".cursor-plugin")) systemPhase = 1;
      if (!dirs.has(physical) && !files.has(physical)) throw missing();
      if (physical === cancelled) rawHits += 1;
      return {
        dev: 1, ino: identities.get(physical)
          + (physical === cancelled ? phase * 1000 : 0)
          + (((systemPolicy === "root-drift" && physical === knownFolder)
            || (systemPolicy === "raw-root-drift" && physical === systemCancelled)) ? systemPhase * 1000 : 0)
          + (systemPolicy === "query-temp-drift" && physical === join(root, "owned-temp") ? windowsQueryPhase * 1000 : 0)
          + (systemPolicy === "query-profile-drift" && physical === osHome ? windowsQueryPhase * 1000 : 0),
        mode: dirs.has(physical) ? 16877 : 33188, size: files.get(physical)?.length ?? 0,
        isDirectory: () => dirs.has(physical) && !(physical === cancelled && fallbackFault === "regular"),
        isFile: () => files.has(physical) || (physical === cancelled && fallbackFault === "regular"),
        isSymbolicLink: () => physical === cancelled && fallbackFault === "link",
      };
    };
    const realpath = (path) => { stat(path); return resolve(String(path)); };
    realpath.native = realpath;
    mock.module("node:fs", () => ({
      ...originalFs,
      lstatSync: stat, realpathSync: realpath,
      existsSync: (path) => dirs.has(resolve(String(path))) || files.has(resolve(String(path))),
      readFileSync: (path, options) => {
        const bytes = files.get(resolve(String(path)));
        if (bytes === undefined) throw missing();
        const encoding = typeof options === "string" ? options : options?.encoding;
        return encoding === undefined ? bytes : bytes.toString(encoding);
      },
      openSync: (path) => {
        const physical = resolve(String(path));
        if (!files.has(physical)) throw missing();
        if (physical === join(selectedCache, ".codex-plugin", "plugin.json")) {
          cacheManifestOpens += 1;
          if (cacheManifestOpens === 3 && jsonFixture?.artifacts?.payloadAfterInventory !== undefined) {
            // Both inventory snapshots observed the old identity. Swap equal-length bytes only
            // for the subsequent production payload read, retaining the inode/descriptor facts.
            files.set(physical, Buffer.from(jsonFixture.artifacts.payloadAfterInventory));
          }
        }
        const descriptor = nextDescriptor++;
        descriptors.set(descriptor, { path: physical, offset: 0 });
        return descriptor;
      },
      fstatSync: (descriptor) => stat(descriptors.get(descriptor).path),
      readSync: (descriptor, buffer, offset, length, position) => {
        const opened = descriptors.get(descriptor), bytes = files.get(opened.path);
        const start = position ?? opened.offset, count = Math.max(0, Math.min(length, bytes.length - start));
        bytes.copy(buffer, offset, start, start + count);
        opened.offset = start + count;
        return count;
      },
      closeSync: (descriptor) => {
        const opened = descriptors.get(descriptor);
        if (drift && (source === "CODEX_HOME" || source === "OS_HOME")
          && opened.path === join(repo, ".git", "HEAD")) phase = 1;
        descriptors.delete(descriptor);
      },
      readdirSync: (path) => [...dirs].filter((entry) => dirname(entry) === resolve(String(path))
        && entry !== resolve(String(path))).map((entry) => ({
          name: basename(entry), isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false,
        })),
    }));
    mock.module("node:os", () => ({ ...originalOs,
      homedir: () => source === "OS_HOME" ? rawHome : osHome,
      tmpdir: () => systemPolicy === "temp-root" ? join(root, "missing-temp") : originalOs.tmpdir(),
    }));
    process.env.CODEX_HOME = source === "CODEX_HOME" ? rawCodexHome : codexHome;
    if (source === "OS_HOME") delete process.env.CODEX_HOME;
    process.env.HOME = source === "HOME" ? rawHome : osHome;
    process.env.USERPROFILE = source === "USERPROFILE" ? rawHome : osHome;
    if (source === "USERPROFILE" || (source === "OS_HOME" && caller === "status")) delete process.env.HOME;
    if (source === "OS_HOME" && caller === "status") delete process.env.USERPROFILE;
    process.env.ProgramData = join(root, "program-data");
    process.env.PROGRAMDATA = process.env.ProgramData;
    process.env.TEMP = join(root, "owned-temp");
    process.env.TMP = process.env.TEMP;
    process.env.TMPDIR = process.env.TEMP;
    // macOS managed-preference presence is also synthetic; no native process is launched.
    Bun.spawnSync = (argv, options = {}) => {
      if (argv[0] === "/usr/bin/osascript") {
        nativeCalls.push("managed-preferences");
        return { exitCode: 0, stdout: Buffer.from("absent"), stderr: Buffer.alloc(0) };
      }
      if (basename(argv[0]).toLowerCase() === "powershell.exe") {
        nativeCalls.push("known-folder");
        if (systemPolicy === "query-timeout") return { exitCode: 1, stdout: Buffer.alloc(0),
          stderr: Buffer.from("secret-timeout-detail"), exitedDueToTimeout: true };
        if (systemPolicy === "query-output-limit") return { exitCode: 1, stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0), exitedDueToMaxBuffer: true };
        if (systemPolicy === "query-nonzero") return { exitCode: 7, stdout: Buffer.alloc(0),
          stderr: Buffer.from("secret-exit-detail") };
        if (systemPolicy === "query-stderr") return { exitCode: 0, stdout: Buffer.from("QzpcXFByb2dyYW1EYXRh"),
          stderr: Buffer.from("secret-stderr-detail") };
        if (systemPolicy === "query-output-shape") return { exitCode: 0, stdout: Buffer.from("not base64"), stderr: Buffer.alloc(0) };
        if (systemPolicy === "query-decode") return { exitCode: 0,
          stdout: Buffer.from(Buffer.from([0xff]).toString("base64")), stderr: Buffer.alloc(0) };
        if (systemPolicy === "query-path-shape") return { exitCode: 0,
          stdout: Buffer.from(Buffer.from("relative-path").toString("base64")), stderr: Buffer.alloc(0) };
        if (systemPolicy === "query-temp-drift" || systemPolicy === "query-profile-drift") windowsQueryPhase = 1;
        const resolved = systemPolicy === "unresolved" ? "" : systemPolicy === "raw-root-drift"
          ? systemCancelled + sep + ".." + sep + "known-program-data" : knownFolder;
        return { exitCode: 0, stdout: Buffer.from(Buffer.from(resolved).toString("base64")), stderr: Buffer.alloc(0) };
      }
      if (caller === "install" && argv[0] === "git" && argv.includes("--show-toplevel")
        && !argv.includes("-C")) {
        nativeCalls.push("git-root");
        return { exitCode: 0, stdout: Buffer.from(gitRoot), stderr: Buffer.alloc(0) };
      }
      if (jsonFixture?.artifacts !== undefined && argv[0] === "git" && argv.includes("-C")) {
        nativeCalls.push("git-read");
        const checkout = jsonFixture.artifacts.checkout;
        if (checkout === undefined) return { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("not a checkout") };
        if (argv.includes("--show-toplevel") && checkout.topLevelFault !== undefined) return {
          exitCode: 1,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          ...(checkout.topLevelFault === "timeout" ? { exitedDueToTimeout: true } : { exitedDueToMaxBuffer: true }),
        };
        const marketplaceRoot = join(codexHome, ".tmp", "marketplaces", "semctx-stable");
        const value = argv.includes("--show-toplevel")
          ? checkout.topLevel === "parent" ? dirname(marketplaceRoot)
            : checkout.topLevel === "relative" ? "relative-marketplace" : marketplaceRoot
          : argv.includes("get-url") ? checkout.source
          : argv.includes("symbolic-ref") ? checkout.ref
            : argv.includes("rev-parse") ? checkout.revision : null;
        return value === null
          ? { exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("unsupported read") }
          : { exitCode: 0, stdout: Buffer.from(value + "\\n"), stderr: Buffer.alloc(0) };
      }
      if (jsonFixture?.artifacts !== undefined && argv[0] === "git" && argv.includes("rev-parse")) {
        nativeCalls.push("git-read");
        return { exitCode: 0, stdout: Buffer.from(argv.includes("--abbrev-ref")
          ? jsonFixture.artifacts.gitRef ?? "stable" : "1".repeat(40)),
          stderr: Buffer.alloc(0) };
      }
      const ownedCodexInvocation = process.platform === "win32" ? argv[0] === ownedCodex : argv[0] === "codex";
      if (caller === "install" && jsonFixture !== null && ownedCodexInvocation) {
        const semanticArgv = ["codex", ...argv.slice(1)];
        nativeCalls.push("codex-attempt:" + semanticArgv.join(" "));
        nativeOptions.push({ command: semanticArgv, timeout: options.timeout ?? null, maxBuffer: options.maxBuffer ?? null });
        if (jsonFixture.recovery !== undefined) {
          if (semanticArgv[1] === "plugin" && semanticArgv[2] === "marketplace") {
            if (jsonFixture.transport?.timedOutMutation) return {
              exitCode: 0, stdout: Buffer.from("{}"), stderr: Buffer.alloc(0), exitedDueToTimeout: true,
            };
            if (jsonFixture.transport !== undefined) {
              const result = runOwnedHost(semanticArgv, options);
              nativeClockAdvance += jsonFixture.transport.advanceAfterMarketplace ?? 0;
              return result;
            }
            return { exitCode: 0, stdout: Buffer.from("{}"), stderr: Buffer.alloc(0) };
          }
          if (semanticArgv[1] === "plugin" && semanticArgv[2] === "add") {
            if (jsonFixture.recovery.configAfterAdd !== undefined) addFile(
              join(codexHome, "config.toml"), jsonFixture.recovery.configAfterAdd);
            if (jsonFixture.recovery.sidecarAfterAdd !== undefined) addFile(
              join(codexHome, ".tmp", "marketplaces", "semctx-stable", ".codex-marketplace-install.json"),
              jsonFixture.recovery.sidecarAfterAdd);
            const versioned = join(codexHome, "plugins", "cache", "semctx-stable", "semctx-control", fixtureVersion);
            addFile(join(versioned, ".codex-plugin", "plugin.json"), jsonFixture.recovery.cacheManifest
              ?? JSON.stringify({ name: "semctx-control", version: fixtureVersion }));
            for (const bundle of ["semctx-index-worker.js", "semctx-mcp.js", "semctx-shared.js", "semctx.js"]) {
              addFile(join(versioned, "dist", bundle), "same bundle: " + bundle);
            }
            if (jsonFixture.transport !== undefined) return runOwnedHost(semanticArgv, options);
            if (jsonFixture.recovery.success) return { exitCode: 0, stdout: Buffer.from("{}"), stderr: Buffer.alloc(0) };
            return { exitCode: 1, stdout: Buffer.alloc(0),
              stderr: Buffer.from("failed to back up plugin cache entry: locked (os error 32)") };
          }
          if (semanticArgv[1] === "plugin" && semanticArgv[2] === "list" && jsonFixture.transport !== undefined) {
            return runOwnedHost(semanticArgv, options);
          }
          if (semanticArgv[1] === "plugin" && semanticArgv[2] === "list") {
            const reply = {
              exitCode: 0, stderr: Buffer.alloc(0), stdout: Buffer.from(JSON.stringify({ installed: [{
              pluginId: "semctx-control@semctx-stable", installed: true, enabled: true, version: fixtureVersion,
              source: { path: join(codexHome, ".tmp", "marketplaces", "semctx-stable", "plugins", "semctx-control") },
            }] })),
            };
            if (jsonFixture.recovery.afterNativeList === "disable") {
              const config = join(codexHome, "config.toml");
              addFile(config, files.get(config).toString("utf8").replace("enabled = true", "enabled = false"));
            } else if (jsonFixture.recovery.afterNativeList === "higher-cache") {
              const newer = join(codexHome, "plugins", "cache", "semctx-stable", "semctx-control", newerFixtureVersion);
              addFile(join(newer, ".codex-plugin", "plugin.json"),
                JSON.stringify({ name: "semctx-control", version: newerFixtureVersion }));
            }
            return reply;
          }
        }
        return { exitCode: 9, stdout: Buffer.alloc(0), stderr: Buffer.from("native invocation intercepted") };
      }
      nativeCalls.push("unexpected:" + argv[0]);
      throw new Error("unexpected native query: " + argv[0]);
    };
    Bun.spawn = () => {
      nativeCalls.push("cleanup-scheduled");
      return { pid: 123, unref() {} };
    };
    Bun.which = (name) => name === "codex" ? ownedCodex : null;
    const { pluginDeliveryStatus } = await import(${JSON.stringify(moduleUrl)});
    let report;
    if (caller === "install") {
      const { executeInstall } = await import(${JSON.stringify(installUrl)});
      const { parseArgs } = await import(${JSON.stringify(argsUrl)});
      report = executeInstall(repo, parseArgs(["install", "--host", "codex", "--skip-setup",
        ...(jsonFixture?.dryRun === false ? [] : ["--dry-run"])]));
    } else report = pluginDeliveryStatus(
      { repositoryRoot: repo, version: fixtureVersion, scope: "codex" },
      {
        findHostExecutable: () => join(root, "bin", "codex"),
        ...(jsonFixture?.artifacts?.payloadManifest === undefined && jsonFixture?.artifacts?.fixedInventory !== true ? {} : {
          // Keep inventory fixed to exercise the downstream production payload parser itself.
          readCodexPluginMetadata: () => ({
            marketplaces: [{ name: "semctx-stable", root: join(codexHome, ".tmp", "marketplaces", "semctx-stable"),
              marketplaceSource: { sourceType: "git", source: "hoklims/semctx" }, ref: "stable",
              sparsePaths: jsonFixture.artifacts.configuredSparse ?? [] }],
            plugins: [{ pluginId: "semctx-control@semctx-stable", installed: true, enabled: true, version: fixtureVersion,
              cachePath: join(codexHome, "plugins", "cache", "semctx-stable", "semctx-control", fixtureVersion) }],
          }),
        }),
        readRepositoryChannel: () => ({ commit: null, originIsSemctx: false }),
        ...(jsonFixture?.artifacts === undefined ? { readMarketplaceSnapshot: () => null } : {}),
        resolvePublicRelease: () => ({ status: "unresolved", authority: "absent", version: null,
          commit: null, source: null, bundles: null, reasons: [] }),
      },
    );
    process.stdout.write(JSON.stringify({ report, rawHits, phase, cachePath, nativeCalls, nativeOptions, cacheManifestOpens }));
  `;
  const child = Bun.spawnSync([process.execPath, "-e", program], { stdout: "pipe", stderr: "pipe" });
  expect(new TextDecoder().decode(child.stderr)).toBe("");
  expect(child.exitCode).toBe(0);
  const result = JSON.parse(new TextDecoder().decode(child.stdout)) as ProductionObservation | InstallObservation;
  expect(result.nativeCalls.every((call) => call === "known-folder"
    || call === "managed-preferences" || (caller === "install" && call === "git-root")
    || (jsonFixture?.artifacts !== undefined && call === "git-read")
    || (jsonFixture?.recovery !== undefined && call === "cleanup-scheduled")
    || (jsonFixture !== undefined && caller === "install" && call.startsWith("codex-attempt:")))).toBe(true);
  return result;
}

describe("pluginDeliveryStatus production Codex metadata boundary", () => {
  for (const source of ["HOME", "USERPROFILE", "CODEX_HOME", "OS_HOME"] as const) {
    test(`raw ${source} cancelled-directory inode drift stays unknown through the default service`, () => {
      const unchanged = productionStatus(source);
      expect(unchanged.rawHits).toBeGreaterThan(0);
      expect(unchanged.report.hosts.codex.marketplace.configured).toBe(false);
      expect(unchanged.report.hosts.codex.installed.installed).toBeNull();

      const changed = productionStatus(source, true);
      expect(changed.phase).toBe(1);
      expect(changed.rawHits).toBeGreaterThan(0);
      expect(changed.report.hosts.codex.marketplace.configured).toBeNull();
      expect(changed.report.hosts.codex.reasons).toContain("HOST_QUERY_FAILED");
      expect(changed.report.hosts.codex.reasons).not.toContain("MARKETPLACE_NOT_CONFIGURED");
      expect(changed.report.hosts.codex.delivery).toBe("UNKNOWN");
    });
  }

  test("orphan physical local cache remains visible through the default public service", () => {
    const result = productionStatus("CODEX_HOME", false, true);
    const state = result.report.hosts.codex;
    expect(state.marketplace.configured).toBe(false);
    expect(state.installed).toEqual({
      installed: true, path: result.cachePath, version: "0.3.7", enabled: null,
      contentMatchesSnapshot: null, contentMatchesPublicRelease: null,
    });
    expect(state.session.status).toBe("unknown");
    expect(state.session.version).toBeNull();
    expect(state.updateAvailable).toBeNull();
    expect(state.delivery).toBe("UNKNOWN");
    expect(state.verdict).toBe("UNKNOWN");
    expect(state.activation).toBeNull();
    expect(state.convergence).toEqual([]);
    expect(state.reasons).toContain("MARKETPLACE_NOT_CONFIGURED");
  });
});

describe("production Codex status artifact JSON", () => {
  const marketplace = '{"name":"semctx-stable","plugins":[{"name":"semctx-control",'
    + '"source":{"source":"local","path":"./plugins/semctx-control"}}]}';
  const sidecar = '{"source_type":"git","source":"hoklims/semctx","ref_name":"stable","sparse_paths":[],"revision":"'
    + "1".repeat(40) + '"}';
  const observe = (artifacts: NonNullable<ProductionJsonFixture["artifacts"]>) => {
    const observed = productionFixture("CODEX_HOME", false, false, "absent", "status", "safe", { marketplace, artifacts });
    return observed as ProductionObservation;
  };
  const status = (artifacts: NonNullable<ProductionJsonFixture["artifacts"]>) => observe(artifacts).report;

  for (const [name, value] of [
    ["missing sidecar structure", {}],
    ["numeric revision and ref", { source_type: "git", source: "hoklims/semctx", revision: 1, ref_name: 2 }],
    ["missing source identity", { source_type: "git", revision: "1".repeat(40), ref_name: "stable" }],
    ["unrecognized source type", { source_type: "unsupported", source: "hoklims/semctx", revision: "1".repeat(40) }],
    ["missing sparse paths", { source_type: "git", source: "hoklims/semctx", revision: "1".repeat(40), ref_name: "stable" }],
    ["wrong sparse element type", { source_type: "git", source: "hoklims/semctx", revision: "1".repeat(40),
      ref_name: "stable", sparse_paths: [1] }],
    ["raw revision whitespace", { source_type: "git", source: "hoklims/semctx", revision: " " + "1".repeat(40),
      ref_name: "stable", sparse_paths: [] }],
    ["contradictory source identity", { source_type: "git", source: "someone/else", revision: "1".repeat(40),
      ref_name: "stable", sparse_paths: [] }],
  ] as const) {
    test(`${name} refuses present sidecar without any Git fallback`, () => {
      // Pin an admitted inventory to keep exercising the downstream snapshot reader.
      const observed = observe({ sidecar: JSON.stringify(value), fixedInventory: true });
      expect({ version: observed.report.hosts.codex.snapshot.version,
        gitReads: observed.nativeCalls.filter((call) => call === "git-read"),
        unreadable: observed.report.hosts.codex.reasons.includes("SNAPSHOT_UNREADABLE") })
        .toEqual({ version: null, gitReads: [], unreadable: true });
    });
  }

  for (const [name, bytes] of [
    ["duplicate sidecar revision", sidecar.replace('"revision":', '"revision":"foreign","revision":')],
    ["escaped sidecar duplicate", sidecar.replace('"revision":', String.raw`"revision":"foreign","\u0072evision":`)],
    ["unpaired sidecar Unicode", sidecar.replace('"ref_name":"stable"', String.raw`"ref_name":"\ud800"`)],
    ["invalid sidecar syntax", "{"],
    ["empty present sidecar", ""],
    ["invalid sidecar UTF-8", [...Buffer.from(sidecar.slice(0, -1) + ',"note":"'), 0xff, ...Buffer.from('"}')]],
  ] as const) {
    test(`${name} remains unknown through the effective default status`, () => {
      const report = status({ sidecar: typeof bytes === "string" ? bytes : [...bytes], fixedInventory: true });
      expect(report.hosts.codex.snapshot.version).toBeNull();
      expect(report.hosts.codex.reasons).toContain("SNAPSHOT_UNREADABLE");
      expect(report.hosts.codex.delivery).toBe("UNKNOWN");
      expect(report.publicRelease.authority).toBe("absent");
    });
  }

  test("sidecar absence and a valid sidecar preserve version observations without release authority", () => {
    for (const artifacts of [{}, { sidecar }]) {
      const report = status(artifacts);
      expect(report.hosts.codex.snapshot.version).toBe("0.3.7");
      expect(report.hosts.codex.reasons).not.toContain("SNAPSHOT_UNREADABLE");
      expect(report.publicRelease.authority).toBe("absent");
    }
  });

  test("native optional refs and local identity remain readable without Git fallback", () => {
    const native = { source_type: "git", source: "hoklims/semctx", sparse_paths: [], revision: "1".repeat(40) };
    for (const artifacts of [{ sidecar: JSON.stringify(native), configuredRef: null },
      { sidecar: JSON.stringify({ ...native, ref_name: null }), configuredRef: null }, { localSidecar: true }]) {
      const observed = observe(artifacts);
      expect(observed.report.hosts.codex.snapshot.version).toBe("0.3.7");
      expect(observed.report.hosts.codex.reasons).not.toContain("SNAPSHOT_UNREADABLE");
      expect(observed.nativeCalls).not.toContain("git-read");
      expect(observed.report.publicRelease.authority).toBe("absent");
    }
  });

  const invalidManifest = '{"name":"semctx-control","version":"old","version":"0.3.7"}';
  test("a duplicate snapshot manifest version is unknown through default snapshot reads", () => {
    const report = status({ sidecar, snapshotManifest: invalidManifest });
    expect(report.hosts.codex.snapshot.version).toBeNull();
    expect(report.hosts.codex.reasons).toContain("SNAPSHOT_UNREADABLE");
    expect(report.hosts.codex.delivery).toBe("UNKNOWN");
  });

  test("a duplicate payload manifest version is unknown through default payload reads", () => {
    const report = status({ sidecar, payloadManifest: invalidManifest });
    expect(report.hosts.codex.installed.version).toBeNull();
    expect(report.hosts.codex.reasons).toContain("INSTALLED_CACHE_UNREADABLE");
    expect(report.hosts.codex.delivery).toBe("UNKNOWN");
  });
});

describe("production Codex admitted cache version and native build metadata", () => {
  const marketplace = '{"name":"semctx-stable","plugins":[{"name":"semctx-control",'
    + '"source":{"source":"local","path":"./plugins/semctx-control"}}]}';
  const sidecar = JSON.stringify({ source_type: "git", source: "hoklims/semctx", ref_name: "stable",
    sparse_paths: [], revision: "1".repeat(40) });
  const manifest = (version: string) => JSON.stringify({ name: "semctx-control", version });
  const status = (artifacts: NonNullable<ProductionJsonFixture["artifacts"]>) =>
    productionFixture("CODEX_HOME", false, false, "absent", "status", "safe", {
      marketplace, artifacts: { sidecar, matchingBundles: true, ...artifacts },
    }) as ProductionObservation;

  for (const before of [true, false]) {
    test(`native build-metadata order selects the higher peer inserted ${before ? "before" : "after"}`, () => {
      const observed = status({
        matchingBundles: true,
        cachePeers: [{ version: "0.3.7+build.2", before, bundlePrefix: "different bundle: " }],
      });
      expect(observed.report.hosts.codex.installed.version).toBe("0.3.7+build.2");
      expect(observed.report.hosts.codex.installed.contentMatchesSnapshot).toBe(false);
    });
  }
  for (const reverse of [false, true]) {
    test(`arbitrary-length numeric prerelease order follows digit length (${reverse ? "reverse" : "forward"})`, () => {
      const peers = [
        { version: "1.0.0-99999999999999999999", before: true, bundlePrefix: "lower: " },
        { version: "1.0.0-100000000000000000000", before: true, bundlePrefix: "higher: " },
      ];
      const observed = status({ cachePeers: reverse ? peers.reverse() : peers });
      expect(observed.report.hosts.codex.installed.version).toBe("1.0.0-100000000000000000000");
      expect(observed.report.hosts.codex.installed.contentMatchesSnapshot).toBe(false);
    });
    test(`ordinary numeric prerelease control selects 100 over 99 (${reverse ? "reverse" : "forward"})`, () => {
      const peers = [
        { version: "1.0.0-99", before: true, bundlePrefix: "lower: " },
        { version: "1.0.0-100", before: true, bundlePrefix: "higher: " },
      ];
      const observed = status({ cachePeers: reverse ? peers.reverse() : peers });
      expect(observed.report.hosts.codex.installed.version).toBe("1.0.0-100");
    });
  }
  test("build metadata uses native numeric leading-zero ordering", () => {
    const observed = status({ cachePeers: [
      { version: "0.3.7+0", before: true, bundlePrefix: "zero: " },
      { version: "0.3.7+00", before: false, bundlePrefix: "double-zero: " },
    ] });
    expect(observed.report.hosts.codex.installed.version).toBe("0.3.7+00");
  });
  test("build metadata orders nonnumeric identifiers above numeric identifiers", () => {
    const observed = status({ cachePeers: [
      { version: "0.3.7+9", before: false, bundlePrefix: "numeric: " },
      { version: "0.3.7+alpha", before: true, bundlePrefix: "alpha: " },
    ] });
    expect(observed.report.hosts.codex.installed.version).toBe("0.3.7+alpha");
  });
  test("cache numeric core components must fit native Rust u64 parsing", () => {
    const observed = status({
      cachePeers: [{ version: "18446744073709551616.0.0", before: false, bundlePrefix: "overflow: " }],
    });
    expect(observed.report.hosts.codex.marketplace.configured).toBeNull();
    expect(observed.report.hosts.codex.reasons).toContain("HOST_QUERY_FAILED");
  });
  test("native u64 boundary and arbitrarily long numeric prerelease identifiers stay valid", () => {
    expect(codexPluginManifestIdentity({ name: "semctx-control", version: "18446744073709551615.0.0" },
      "semctx-control")?.version).toBe("18446744073709551615.0.0");
    const prerelease = "1.0.0-18446744073709551616000000000000000000+build.2";
    expect(codexPluginManifestIdentity({ name: "semctx-control", version: prerelease },
      "semctx-control")?.version).toBe(prerelease);
  });

  for (const localCache of [false, true]) {
    test(`third payload version drift at ${localCache ? "local" : "0.3.7"} never replaces the admitted inventory identity`, () => {
      const observed = status({ localCache, snapshotManifest: manifest("0.3.8"), payloadAfterInventory: manifest("0.3.8") });
      const host = observed.report.hosts.codex;
      expect(observed.cacheManifestOpens).toBe(3);
      expect(host.snapshot.version).toBe("0.3.8");
      expect(host.installed.path?.endsWith(localCache ? "local" : "0.3.7")).toBe(true);
      expect({ version: host.installed.version, snapshotContent: host.installed.contentMatchesSnapshot,
        publicContent: host.installed.contentMatchesPublicRelease })
        .toEqual({ version: null, snapshotContent: null, publicContent: null });
      expect(host.reasons).toContain("INSTALLED_CACHE_UNREADABLE");
      expect(host.delivery).toBe("UNKNOWN");
      expect(observed.report.publicRelease.authority).toBe("absent");
    });
    test(`unchanged admitted version at ${localCache ? "local" : "0.3.7"} preserves the stale snapshot diagnostic`, () => {
      const observed = status({ localCache, snapshotManifest: manifest("0.3.8") });
      expect(observed.cacheManifestOpens).toBe(3);
      expect(observed.report.hosts.codex.installed.version).toBe("0.3.7");
      expect(observed.report.hosts.codex.installed.contentMatchesSnapshot).toBe(true);
      expect(observed.report.hosts.codex.reasons).toContain("INSTALLED_CACHE_BEHIND_SNAPSHOT");
      expect(observed.report.publicRelease.authority).toBe("absent");
    });
  }
  test("an exact version at the local directory is compared to its declared version, not its basename", () => {
    const observed = status({ localCache: true });
    expect(observed.report.hosts.codex.installed.version).toBe("0.3.7");
    expect(observed.report.hosts.codex.installed.contentMatchesSnapshot).toBe(true);
    expect(observed.report.hosts.codex.reasons).not.toContain("INSTALLED_CACHE_UNREADABLE");
    expect(observed.report.hosts.codex.reasons).not.toContain("INSTALLED_CACHE_BEHIND_SNAPSHOT");
  });

  for (const version of ["1.2.3", "1.2.3+build.2"] as const) {
    test(`unrelated helper ${version} admits actual status, preflight and ordinary default apply`, () => {
      const observed = productionFixture("CODEX_HOME", false, false, "absent", "status", "safe", {
        marketplace, artifacts: { sidecar }, unrelatedCache: { version },
      }) as ProductionObservation;
      const installs = [true, false].map((dryRun) => productionFixture("CODEX_HOME", false, false, "absent", "install", "safe", {
        marketplace, dryRun, recovery: { success: true }, unrelatedCache: { version },
      }) as InstallObservation);
      expect({ configured: observed.report.hosts.codex.marketplace.configured,
        preflight: installs[0]?.report.hosts.codex.status, apply: installs[1]?.report.hosts.codex.status,
        calls: installs.map((install) => install.nativeCalls.filter((call) => call.startsWith("codex-attempt:")).length) })
        .toEqual({ configured: true, preflight: "planned", apply: "updated", calls: [0, 3] });
      expect(observed.report.hosts.codex.marketplace.configured).toBe(true);
      expect(observed.report.hosts.codex.installed.version).toBe("0.3.7");
      expect(observed.report.hosts.codex.reasons).not.toContain("HOST_QUERY_FAILED");
      for (const [index, install] of installs.entries()) {
        expect(install.report.ok).toBe(true);
        expect(install.report.hosts.codex.status).toBe(index === 0 ? "planned" : "updated");
        const native = install.nativeCalls.filter((call) => call.startsWith("codex-attempt:"));
        expect(native).toHaveLength(index === 0 ? 0 : 3);
      }
    });
  }
  for (const [name, unrelatedCache] of [
    ["directory/manifest raw version mismatch", { version: "1.2.3", declaredVersion: "1.2.4" }],
    ["foreign plugin manifest identity", { version: "1.2.3", pluginName: "foreign" }],
    ["unsafe version separator", { version: "1.2.3/escape" }],
    ["unsafe version whitespace", { version: "1.2.3 build" }],
  ] as const) {
    test(`${name} still refuses preflight/apply before any native host`, () => {
      for (const dryRun of [true, false]) {
        const observed = productionFixture("CODEX_HOME", false, false, "absent", "install", "safe", {
          marketplace, dryRun, recovery: { success: true }, unrelatedCache,
        }) as InstallObservation;
        expect(observed.report.ok).toBe(false);
        expect(observed.report.hosts.codex.status).toBe("failed");
        expect(observed.nativeCalls.filter((call) => call.startsWith("codex-attempt:"))).toEqual([]);
      }
    });
  }
});

describe("Codex raw identity and unsupported Date production", () => {
  const marketplace = '{"name":"semctx-stable","plugins":[{"name":"semctx-control",'
    + '"source":{"source":"local","path":"./plugins/semctx-control"}}]}';
  const native = { source_type: "git", source: "hoklims/semctx", ref_name: "stable", sparse_paths: [], revision: "1".repeat(40) };
  const status = (artifacts: NonNullable<ProductionJsonFixture["artifacts"]>) =>
    (productionFixture("CODEX_HOME", false, false, "absent", "status", "safe", { marketplace, artifacts }) as ProductionObservation).report;
  for (const [name, version] of [
    ["whitespace", " 0.3.7 "], ["embedded NUL", "0.3.\u00007"], ["bidi control", "0.3.\u202e7"],
  ] as const) {
    test(`${name} snapshot version cannot become the displayed canonical identity`, () => {
      const report = status({ sidecar: JSON.stringify(native), snapshotManifest: JSON.stringify({ name: "semctx-control", version }) });
      expect(report.hosts.codex.snapshot.version).toBeNull();
      expect(report.hosts.codex.reasons).toContain("SNAPSHOT_UNREADABLE");
    });
    test(`${name} payload version cannot become the displayed canonical identity`, () => {
      const report = status({ sidecar: JSON.stringify(native), payloadManifest: JSON.stringify({ name: "semctx-control", version }) });
      expect(report.hosts.codex.installed.version).toBeNull();
      expect(report.hosts.codex.reasons).toContain("INSTALLED_CACHE_UNREADABLE");
    });
  }
  test("a bidi ref is compared raw to stable before safe display", () => {
    const ref = "sta\u202eble";
    const report = status({ configuredRef: ref, sidecar: JSON.stringify({ ...native, ref_name: ref }) });
    expect(report.hosts.codex.snapshot.version).toBe("0.3.7");
    expect(report.hosts.codex.reasons).toContain("MARKETPLACE_REF_UNEXPECTED");
    expect(report.hosts.codex.delivery).not.toBe("UP_TO_DATE");
  });
  test("a configured stable ref cannot mask a contradictory sidecar-absent raw Git branch", () => {
    const report = status({ configuredRef: "stable", gitRef: "sta\u202eble", matchingBundles: true });
    expect(report.hosts.codex.marketplace.ref).toBe("stable");
    expect(report.hosts.codex.snapshot.version).toBeNull();
    expect(report.hosts.codex.reasons).toContain("MARKETPLACE_REF_UNEXPECTED");
    expect(report.hosts.codex.delivery).toBe("UNKNOWN");
  });
  test("valid raw SemVer and stable ref preserve canonical observations", () => {
    const report = status({ sidecar: JSON.stringify(native), snapshotManifest: '{"name":"semctx-control","version":"0.3.7-rc.1+build.2"}' });
    expect(report.hosts.codex.snapshot.version).toBe("0.3.7-rc.1+build.2");
    expect(report.hosts.codex.reasons).not.toContain("MARKETPLACE_REF_UNEXPECTED");
    expect(report.publicRelease.authority).toBe("absent");
  });

  for (const location of ["system", "cwd", "ancestor"] as const) {
    test(`${location} Date feature container refuses status and default dry-run/apply before native Codex`, () => {
      const fixture = { marketplace, artifacts: { sidecar: JSON.stringify(native) },
        unsupportedLayer: { location, text: "features = 1979-05-27T07:32:00Z\n" } };
      const statusObserved = productionFixture("CODEX_HOME", false, false, "absent", "status", "safe", fixture) as ProductionObservation;
      const installs = [true, false].map((dryRun) => productionFixture("CODEX_HOME", false, false, "absent",
        "install", "safe", { ...fixture, dryRun }) as InstallObservation);
      expect(installs.map((observed) => ({ status: observed.report.hosts.codex.status,
        calls: observed.nativeCalls.filter((call) => call.startsWith("codex-attempt:")) })))
        .toEqual([{ status: "failed", calls: [] }, { status: "failed", calls: [] }]);
      expect(statusObserved.report.hosts.codex.marketplace.configured).toBeNull();
      expect(statusObserved.report.hosts.codex.reasons).toContain("HOST_QUERY_FAILED");
    });
    test(`${location} false feature container refuses and empty table remains irrelevant`, () => {
      for (const [text, expected] of [["features = false\n", "failed"], ["features = {}\n", "planned"]] as const) {
        const observed = productionFixture("CODEX_HOME", false, false, "absent", "install", "safe", {
          marketplace, dryRun: true, artifacts: { sidecar: JSON.stringify(native) }, unsupportedLayer: { location, text },
        }) as InstallObservation;
        expect(observed.report.hosts.codex.status).toBe(expected);
        expect(observed.nativeCalls.filter((call) => call.startsWith("codex-attempt:"))).toEqual([]);
      }
    });
  }
});

describe("Codex native trusted project merge production", () => {
  const marketplace = '{"name":"semctx-stable","plugins":[{"name":"semctx-control",'
    + '"source":{"source":"local","path":"./plugins/semctx-control"}}]}';
  const partial = "[marketplaces.semctx-stable]\nsource_type = 'git'\nsource = 'hoklims/semctx'\n";
  const native = { source_type: "git", source: "hoklims/semctx", revision: "1".repeat(40) };
  const observe = (artifacts: NonNullable<ProductionJsonFixture["artifacts"]>, caller: "status" | "install", dryRun = true) =>
    productionFixture("CODEX_HOME", false, false, "absent", caller, "safe", { marketplace, artifacts, dryRun });

  test("partial project source cannot erase inherited user ref and sparse vector before dry-run or apply", () => {
    const artifacts = { configuredRef: "other-ref", configuredSparse: ["private-tree"], projectConfig: partial,
      sidecar: JSON.stringify({ ...native, ref_name: null, sparse_paths: [] }) };
    const installs = [true, false].map((dryRun) => observe(artifacts, "install", dryRun) as InstallObservation);
    expect(installs.map((observed) => ({ status: observed.report.hosts.codex.status,
      calls: observed.nativeCalls.filter((call) => call.startsWith("codex-attempt:")) })))
      .toEqual([{ status: "failed", calls: [] }, { status: "failed", calls: [] }]);
    const status = observe(artifacts, "status") as ProductionObservation;
    expect(status.report.hosts.codex.snapshot.version).toBeNull();
    expect(status.report.hosts.codex.reasons).toContain("HOST_QUERY_FAILED");
    expect(status.report.hosts.codex.delivery).toBe("UNKNOWN");
  });

  test("partial project source retains matching raw identity and enabled cache observations", () => {
    const artifacts = { configuredRef: "other-ref", configuredSparse: ["private-tree", "./tree", "private-tree"],
      projectConfig: partial, sidecar: JSON.stringify({ ...native, ref_name: "other-ref",
        sparse_paths: ["private-tree", "./tree", "private-tree"] }) };
    const status = observe(artifacts, "status") as ProductionObservation;
    expect(status.report.hosts.codex.marketplace.configured).toBe(true);
    expect(status.report.hosts.codex.marketplace.ref).toBe("other-ref");
    expect(status.report.hosts.codex.snapshot.commit).toBe("1".repeat(40));
    expect(status.report.hosts.codex.snapshot.version).toBe("0.3.7");
    expect(status.report.hosts.codex.installed.installed).toBe(true);
    expect(status.report.hosts.codex.installed.enabled).toBe(true);
    expect(status.report.publicRelease.authority).toBe("absent");
    const install = observe(artifacts, "install") as InstallObservation;
    expect(install.report.hosts.codex.status).toBe("planned");
    expect(install.nativeCalls.filter((call) => call.startsWith("codex-attempt:"))).toEqual([]);
  });

  test("explicit project ref and empty vector replace the user values without erasing source", () => {
    const artifacts = { configuredRef: "other-ref", configuredSparse: ["private-tree"],
      projectConfig: "[marketplaces.semctx-stable]\nref = 'stable'\nsparse_paths = []\n",
      sidecar: JSON.stringify({ ...native, ref_name: "stable", sparse_paths: [] }) };
    const status = observe(artifacts, "status") as ProductionObservation;
    expect(status.report.hosts.codex.marketplace.ref).toBe("stable");
    expect(status.report.hosts.codex.snapshot.version).toBe("0.3.7");
    const install = observe(artifacts, "install") as InstallObservation;
    expect(install.report.hosts.codex.status).toBe("planned");
    expect(install.nativeCalls.filter((call) => call.startsWith("codex-attempt:"))).toEqual([]);
  });

  const enabledConfig = "[marketplaces.semctx-stable]\nsource_type = 'git'\nsource = 'hoklims/semctx'\nref = 'stable'\n"
    + "[plugins.'semctx-control@semctx-stable']\nenabled = true\n";
  test("a trusted project feature true overrides user false through default status and installer", () => {
    const artifacts = { userConfig: "[features]\nplugins = false\n" + enabledConfig,
      projectConfig: "[features]\nplugins = true\n", sidecar: JSON.stringify({ ...native, ref_name: "stable", sparse_paths: [] }) };
    const status = observe(artifacts, "status") as ProductionObservation;
    expect(status.report.hosts.codex.snapshot.version).toBe("0.3.7");
    expect(status.report.hosts.codex.installed.enabled).toBe(true);
    const install = observe(artifacts, "install") as InstallObservation;
    expect(install.report.hosts.codex.status).toBe("planned");
    expect(install.nativeCalls.filter((call) => call.startsWith("codex-attempt:"))).toEqual([]);
  });

  test("a trusted project feature false refuses default dry-run and apply before native Codex", () => {
    const artifacts = { userConfig: "[features]\nplugins = true\n" + enabledConfig,
      projectConfig: "[features]\nplugins = false\n", sidecar: JSON.stringify({ ...native, ref_name: "stable", sparse_paths: [] }) };
    const installs = [true, false].map((dryRun) => observe(artifacts, "install", dryRun) as InstallObservation);
    expect(installs.map((observed) => ({ status: observed.report.hosts.codex.status,
      calls: observed.nativeCalls.filter((call) => call.startsWith("codex-attempt:")) })))
      .toEqual([{ status: "failed", calls: [] }, { status: "failed", calls: [] }]);
  });
});

describe("Codex sidecar consumer admission", () => {
  const marketplace = '{"name":"semctx-stable","plugins":[{"name":"semctx-control",'
    + '"source":{"source":"local","path":"./plugins/semctx-control"}}]}';
  const native = { source_type: "git", source: "hoklims/semctx", ref_name: "stable",
    sparse_paths: [] as string[], revision: "1".repeat(40) };
  const install = (artifacts: NonNullable<ProductionJsonFixture["artifacts"]>, dryRun: boolean) =>
    productionFixture("CODEX_HOME", false, false, "absent", "install", "safe", { marketplace, artifacts, dryRun }) as InstallObservation;
  test("an unregistered selected namespace without a coherent checkout or expected plugin blocks native add", () => {
    const emptyMarketplace = '{"name":"semctx-stable","plugins":[]}';
    const observations = [true, false].map((dryRun) => productionFixture("CODEX_HOME", false, false,
      "absent", "install", "safe", { dryRun, marketplace: emptyMarketplace,
        artifacts: { unregistered: true, sidecar: JSON.stringify(native) } }) as InstallObservation);
    expect(observations.every((observed) => observed.report.hosts.codex.status === "failed")).toBe(true);
    expect(observations.flatMap((observed) => observed.nativeCalls)
      .filter((call) => call.startsWith("codex-attempt:"))).toEqual([]);
  });
  test("an ancestor Git repository cannot lend identity to the selected snapshot directory", () => {
    const checkout = { source: "https://github.com/hoklims/semctx.git", ref: "stable",
      revision: "1".repeat(40), topLevel: "parent" as const };
    const observations = [true, false].map((dryRun) => install({
      unregistered: true,
      sidecar: JSON.stringify(native),
      checkout,
    }, dryRun));
    expect(observations.every((observed) => observed.report.hosts.codex.status === "failed")).toBe(true);
    expect(observations.flatMap((observed) => observed.nativeCalls)
      .filter((call) => call.startsWith("codex-attempt:"))).toEqual([]);
  });
  for (const [name, topLevel, topLevelFault] of [
    ["relative path", "relative", undefined],
    ["timeout", undefined, "timeout"],
    ["truncated output", undefined, "truncated"],
  ] as const) {
    test(`an unprovable checkout root (${name}) blocks native add`, () => {
      const observed = install({
        unregistered: true,
        sidecar: JSON.stringify(native),
        checkout: { source: "https://github.com/hoklims/semctx.git", ref: "stable",
          revision: "1".repeat(40), topLevel, topLevelFault },
      }, false);
      expect(observed.report.hosts.codex.status).toBe("failed");
      expect(observed.nativeCalls.filter((call) => call.startsWith("codex-attempt:"))).toEqual([]);
    });
  }
  test("NUL sparse paths block status and installer admission before native upgrade", () => {
    const sparsePaths = ["a\u0000b"];
    const artifacts = { configuredSparse: sparsePaths,
      sidecar: JSON.stringify({ ...native, sparse_paths: sparsePaths }) };
    const status = productionFixture("CODEX_HOME", false, false, "absent", "status", "safe",
      { marketplace, artifacts }) as ProductionObservation;
    const installs = [true, false].map((dryRun) => install(artifacts, dryRun));
    expect(status.report.hosts.codex.reasons).toContain("HOST_QUERY_FAILED");
    expect(installs.every((observed) => observed.report.hosts.codex.status === "failed")).toBe(true);
    expect(installs.flatMap((observed) => observed.nativeCalls)
      .filter((call) => call.startsWith("codex-attempt:"))).toEqual([]);
  });
  for (const [name, sidecar] of [
    ["missing identity", undefined],
    ["malformed identity", "{"],
    ["foreign source", JSON.stringify({ ...native, source: "someone/else" })],
    ["contradictory sparse vector", JSON.stringify({ ...native, sparse_paths: ["different-tree"] })],
  ] as const) {
    test(`unregistered selected snapshot ${name} blocks dry-run and apply before native Codex`, () => {
      const observations = [true, false].map((dryRun) => install({ unregistered: true, sidecar }, dryRun));
      expect(observations.map((observed) => ({ status: observed.report.hosts.codex.status,
        calls: observed.nativeCalls.filter((call) => call.startsWith("codex-attempt:")) })))
        .toEqual([{ status: "failed", calls: [] }, { status: "failed", calls: [] }]);
    });
  }

  test("an unregistered selected snapshot with a foreign manifest remains unknown before native Codex", () => {
    const observations = [true, false].map((dryRun) => productionFixture("CODEX_HOME", false, false,
      "absent", "install", "safe", { dryRun, marketplace: '{"name":"foreign","plugins":[]}',
        artifacts: { unregistered: true, sidecar: JSON.stringify(native) } }) as InstallObservation);
    expect(observations.map((observed) => observed.nativeCalls.filter((call) => call.startsWith("codex-attempt:"))))
      .toEqual([[], []]);
    expect(observations.every((observed) => observed.report.hosts.codex.status === "failed")).toBe(true);
  });

  test("a valid unregistered public snapshot retains the orphan physical cache without registration", () => {
    const artifacts = { unregistered: true, orphanCache: true, sidecar: JSON.stringify(native),
      checkout: { source: "https://github.com/hoklims/semctx.git", ref: "stable", revision: "1".repeat(40) } };
    const observed = productionFixture("CODEX_HOME", false, false, "absent", "status", "safe", { marketplace, artifacts }) as ProductionObservation;
    expect(observed.report.hosts.codex.marketplace.configured).toBe(false);
    expect(observed.report.hosts.codex.installed.installed).toBe(true);
    expect(observed.report.hosts.codex.installed.version).toBe("0.3.7");
    expect(observed.report.hosts.codex.installed.enabled).toBeNull();
    expect(observed.report.hosts.codex.installed.contentMatchesSnapshot).toBeNull();
    expect(observed.report.hosts.codex.delivery).toBe("UNKNOWN");
    for (const dryRun of [true, false]) {
      const installObserved = install(artifacts, dryRun);
      expect(installObserved.report.hosts.codex.status).toBe("conflict");
      expect(installObserved.nativeCalls.filter((call) => call.startsWith("codex-attempt:"))).toEqual([]);
    }
  });
  for (const [name, sidecar] of [
    ["malformed JSON", "{"],
    ["contradictory source", JSON.stringify({ ...native, source: "someone/else" })],
    ["contradictory ref", JSON.stringify({ ...native, ref_name: "main" })],
    ["duplicate decoded source", String.raw`{"source_type":"git","source":"someone/else","\u0073ource":"hoklims/semctx","ref_name":"stable","sparse_paths":[],"revision":"${"1".repeat(40)}"}`],
    ["unpaired escaped string", JSON.stringify(native).replace(/}$/, String.raw`,"note":"\ud800"}`)],
  ] as const) {
    test(`${name} blocks default dry-run and apply before any native Codex call`, () => {
      const observations = [true, false].map((dryRun) => install({ sidecar }, dryRun));
      expect(observations.map((observed) => ({ ok: observed.report.ok, status: observed.report.hosts.codex.status,
        calls: observed.nativeCalls.filter((call) => call.startsWith("codex-attempt:")) })))
        .toEqual([{ ok: false, status: "failed", calls: [] }, { ok: false, status: "failed", calls: [] }]);
      const observed = productionFixture("CODEX_HOME", false, false, "absent", "status", "safe", {
        marketplace, artifacts: { sidecar },
      }) as ProductionObservation;
      expect(observed.report.hosts.codex.snapshot.version).toBeNull();
      expect(observed.report.hosts.codex.reasons).toContain("HOST_QUERY_FAILED");
      expect(observed.report.hosts.codex.delivery).toBe("UNKNOWN");
    });
  }

  for (const [name, configuredSparse, sparse_paths] of [
    ["different sparse tree", [], ["different-tree"]],
    ["sparse vector order", ["plugins", "skills"], ["skills", "plugins"]],
    ["sparse vector duplicates", ["plugins"], ["plugins", "plugins"]],
    ["raw sparse dot segments", ["plugins"], ["./plugins"]],
  ] as const) {
    test(`${name} stays unknown in status and blocks default installer admission`, () => {
      const artifacts = { sidecar: JSON.stringify({ ...native, sparse_paths }), configuredSparse: [...configuredSparse] };
      for (const fixedInventory of [false, true]) {
        const observed = productionFixture("CODEX_HOME", false, false, "absent", "status", "safe", {
          marketplace, artifacts: { ...artifacts, fixedInventory },
        }) as ProductionObservation;
        expect(observed.report.hosts.codex.snapshot.version).toBeNull();
        expect(observed.report.hosts.codex.delivery).toBe("UNKNOWN");
        expect(observed.nativeCalls).not.toContain("git-read");
        if (fixedInventory) expect(observed.report.hosts.codex.reasons).toContain("SNAPSHOT_UNREADABLE");
      }
      const observations = [true, false].map((dryRun) => install(artifacts, dryRun));
      expect(observations.map((observed) => observed.nativeCalls.filter((call) => call.startsWith("codex-attempt:"))))
        .toEqual([[], []]);
      expect(observations.every((observed) => observed.report.hosts.codex.status === "failed")).toBe(true);
    });
  }

  test("native sidecar absence and exact raw vectors retain default dry-run admission", () => {
    const sparse = ["plugins", "plugins", "./skills", "quoted-\"tree", "emoji-😀"];
    for (const artifacts of [{}, { sidecar: JSON.stringify(native) },
      { configuredSparse: sparse, sidecar: JSON.stringify({ ...native, sparse_paths: sparse }) }]) {
      const observed = install(artifacts, true);
      expect(observed.report.ok).toBe(true);
      expect(observed.report.hosts.codex.status).toBe("planned");
      expect(observed.nativeCalls.filter((call) => call.startsWith("codex-attempt:"))).toEqual([]);
    }
  });

  for (const [name, sidecarAfterAdd] of [
    ["malformed sidecar", "{"],
    ["changed sparse vector", JSON.stringify({ ...native, sparse_paths: ["different-tree"] })],
  ] as const) {
    test.skipIf(process.platform !== "win32")(`${name} after native add cannot prove cache-lock recovery`, () => {
      const observed = productionFixture("CODEX_HOME", false, false, "absent", "install", "safe", {
        marketplace, dryRun: false, recovery: { sidecarAfterAdd },
      }) as InstallObservation;
      expect(observed.report.ok).toBe(false);
      expect(observed.report.hosts.codex.cleanupDeferred).not.toBe(true);
      expect(observed.nativeCalls).not.toContain("cleanup-scheduled");
      expect(observed.report.hosts.codex.error).toContain("metadata");
    });
  }
});

describe("default installer Windows cache-lock payload convergence", () => {
  const marketplace = '{"name":"semctx-stable","plugins":[{"name":"semctx-control",'
    + '"source":{"source":"local","path":"./plugins/semctx-control"}}]}';
  const recover = (location: "snapshotManifest" | "cacheManifest", manifest: string) =>
    productionFixture("CODEX_HOME", false, false, "absent", "install", "safe", {
      marketplace, dryRun: false, recovery: { [location]: manifest },
    }) as InstallObservation;

  for (const location of ["snapshotManifest", "cacheManifest"] as const) {
    for (const [name, manifest] of [
      ["duplicate version", '{"name":"semctx-control","version":"0.3.6","version":"0.3.7"}'],
      ["escaped equivalent version", String.raw`{"name":"semctx-control","version":"0.3.6","\u0076ersion":"0.3.7"}`],
      ["unpaired escaped surrogate", String.raw`{"name":"semctx-control","version":"0.3.7","notes":"\ud800"}`],
      ["plain stale version control", '{"name":"semctx-control","version":"0.3.6"}'],
    ] as const) {
      test.skipIf(process.platform !== "win32")(`${location} ${name} blocks native-lock recovery and cleanup`, () => {
        const observed = recover(location, manifest);
        expect({ ok: observed.report.ok, cleanup: observed.nativeCalls.includes("cleanup-scheduled"),
          deferred: observed.report.hosts.codex.cleanupDeferred === true })
          .toEqual({ ok: false, cleanup: false, deferred: false });
        expect(observed.report.hosts.codex.status).toBe("failed");
        expect(observed.report.hosts.codex.error).toContain(
          name === "plain stale version control"
            ? "declares v"
            : "does not declare the expected plugin identity",
        );
      });
    }
  }

  test.skipIf(process.platform !== "win32")("plain current payloads prove recovery through the default reader", () => {
    const observed = recover("snapshotManifest", JSON.stringify({ name: "semctx-control", version: packageJson.version }));
    expect(observed.report.ok).toBe(true);
    expect(observed.report.hosts.codex.cleanupDeferred).toBe(true);
    expect(observed.nativeCalls).toContain("cleanup-scheduled");
  });
});

describe("default installer final declarative plugin verification", () => {
  const marketplace = '{"name":"semctx-stable","plugins":[{"name":"semctx-control",'
    + '"source":{"source":"local","path":"./plugins/semctx-control"}}]}';
  for (const success of [true, false]) {
    for (const mutation of ["disable", "higher-cache"] as const) {
      test.skipIf(!success && process.platform !== "win32")(
        `${mutation} after native list blocks ${success ? "ordinary success" : "cache-lock recovery"}`,
        () => {
          const observed = productionFixture("CODEX_HOME", false, false, "absent", "install", "safe", {
            marketplace,
            dryRun: false,
            recovery: { success, afterNativeList: mutation },
          }) as InstallObservation;
          expect(observed.report.ok).toBe(false);
          expect(observed.report.hosts.codex.status).toBe("failed");
          expect(observed.nativeCalls).not.toContain("cleanup-scheduled");
          expect(observed.report.hosts.codex.cleanupDeferred).not.toBe(true);
        },
      );
    }
  }
});

describe("default installer preserves the admitted marketplace tuple after apply", () => {
  const marketplace = '{"name":"semctx-stable","plugins":[{"name":"semctx-control",'
    + '"source":{"source":"local","path":"./plugins/semctx-control"}}]}';
  const tuple = (source = "hoklims/semctx", ref = "stable", sparsePaths: string[] = []) => ({ source, ref, sparsePaths });
  const config = (identity: ReturnType<typeof tuple>) => "[marketplaces.semctx-stable]\nsource_type = 'git'\n"
    + `source = ${JSON.stringify(identity.source)}\nref = ${JSON.stringify(identity.ref)}\n`
    + `sparse_paths = ${JSON.stringify(identity.sparsePaths)}\n[plugins.'semctx-control@semctx-stable']\nenabled = true\n`;
  const sidecar = (identity: ReturnType<typeof tuple>) => JSON.stringify({ source_type: "git",
    source: identity.source, ref_name: identity.ref, sparse_paths: identity.sparsePaths, revision: "1".repeat(40) });
  const apply = (before: ReturnType<typeof tuple> | null, after: ReturnType<typeof tuple>, success: boolean) =>
    productionFixture("CODEX_HOME", false, false, "absent", "install", "safe", {
      marketplace, dryRun: false, ...(before === null ? { artifacts: { unregistered: true,
        checkout: { source: "https://github.com/hoklims/semctx.git", ref: "stable", revision: "1".repeat(40) } } } : {}),
      recovery: { configBeforeAdd: before === null ? "" : config(before), configAfterAdd: config(after),
        sidecarAfterAdd: sidecar(after), success },
    }) as InstallObservation;

  for (const success of [true, false]) {
    for (const [name, before, after] of [
      ["coherent foreign source", tuple(), tuple("someone/else")],
      ["coherent replaced ref", tuple(), tuple("hoklims/semctx", "other")],
      ["coherent reordered sparse vector", tuple("hoklims/semctx", "private", ["plugins", "./skills", "plugins"]),
        tuple("hoklims/semctx", "private", ["plugins", "plugins", "./skills"])],
      ["coherent deduplicated sparse vector", tuple("hoklims/semctx", "private", ["plugins", "plugins"]),
        tuple("hoklims/semctx", "private", ["plugins"])],
      ["fresh registration changed from the public plan", null, tuple("someone/else")],
    ] as const) {
      test.skipIf(!success && process.platform !== "win32")(`${name} refuses ${success ? "ordinary success" : "cache-lock recovery"} before cleanup`, () => {
        const observed = apply(before, after, success);
        expect(observed.nativeCalls).toContain("codex-attempt:codex plugin add semctx-control@semctx-stable --json");
        expect(observed.report.ok).toBe(false);
        expect(observed.report.hosts.codex.status).toBe("failed");
        expect(observed.report.hosts.codex.error).toContain("marketplace identity");
        expect(observed.nativeCalls).not.toContain("cleanup-scheduled");
        expect(observed.report.hosts.codex.cleanupDeferred).not.toBe(true);
      });
    }
    test.skipIf(!success && process.platform !== "win32")(`matching raw source/ref/ordered duplicate vector retains ${success ? "ordinary success" : "cache-lock recovery"}`, () => {
      const admitted = tuple("https://github.com/hoklims/semctx.git", "private", ["plugins", "plugins", "./skills"]);
      const observed = apply(admitted, admitted, success);
      expect(observed.report.ok).toBe(true);
      expect(observed.report.hosts.codex.status).toBe("updated");
      expect(observed.nativeCalls.includes("cleanup-scheduled")).toBe(!success);
    });
  }
  test("a fresh matching public tuple remains an installed registration", () => {
    const observed = apply(null, tuple("https://github.com/hoklims/semctx.git"), true);
    expect(observed.report.ok).toBe(true);
    expect(observed.report.hosts.codex.status).toBe("installed");
    expect(observed.nativeCalls).not.toContain("cleanup-scheduled");
  });
});

describe("default installer bounds actual native host executables", () => {
  let directory: string, executable: string;
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "semctx-install-native-budget-"));
    const script = join(directory, "host.js");
    writeFileSync(script, `
      const fs = require("node:fs"), argv = process.argv.slice(2);
      const mode = process.env.SEMCTX_NATIVE_MODE;
      const mutation = argv[1] === "marketplace", readback = argv[1] === "list";
      const finish = () => {
        if (readback) process.stdout.write(JSON.stringify({ installed: [{
          pluginId: "semctx-control@semctx-stable", installed: true, enabled: true, version: ${JSON.stringify(packageJson.version)},
          source: { path: process.env.SEMCTX_NATIVE_SNAPSHOT } }] }));
        else process.stdout.write("{}");
        process.exit(0);
      };
      if (mutation && mode.startsWith("flood")) {
        const chunk = Buffer.alloc(1024 * 1024, 0x7a);
        const streams = mode === "flood-both" ? [1, 2] : [mode === "flood-stdout" ? 1 : 2];
        for (const stream of streams) for (let index = 0; index < 3; index++) fs.writeSync(stream, chunk);
        setTimeout(() => { fs.writeFileSync(process.env.SEMCTX_NATIVE_SENTINEL, "survived"); finish(); }, 2500);
      } else if (readback && mode === "hang-readback") setTimeout(finish, 10000);
      else if (mutation && mode === "slow-mutation") setTimeout(finish, 6000);
      else if (mutation && mode === "unrelated-error") { process.stderr.write("owned host failure"); process.exit(7); }
      else finish();
    `);
    executable = join(directory, process.platform === "win32" ? "codex.exe" : "codex");
    if (process.platform === "win32") {
      const built = Bun.spawnSync([process.execPath, "build", "--compile", script, "--outfile", executable], {
        stdout: "pipe", stderr: "pipe", timeout: 30000, maxBuffer: 1024 * 1024,
      });
      expect(new TextDecoder().decode(built.stderr)).toBe("");
      expect(built.exitCode).toBe(0);
    } else {
      writeFileSync(executable, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
      chmodSync(executable, 0o755);
    }
  });
  afterAll(() => { if (directory !== undefined) rmSync(directory, { recursive: true, force: true }); });
  const run = (mode: string, extra: Partial<NonNullable<ProductionJsonFixture["transport"]>> = {}) => {
    const sentinel = join(directory, `survived-${mode}`);
    const observed = productionFixture("CODEX_HOME", false, false, "absent", "install", "safe", {
      marketplace: '{"name":"semctx-stable","plugins":[{"name":"semctx-control",'
        + '"source":{"source":"local","path":"./plugins/semctx-control"}}]}',
      dryRun: false, recovery: { success: true }, transport: { executable, mode, sentinel, ...extra },
    }) as InstallObservation;
    return { ...observed, sentinel };
  };
  for (const mode of ["flood-stdout", "flood-stderr", "flood-both"] as const) {
    test(`${mode} is refused during the production mutation before add or cleanup`, () => {
      const observed = run(mode);
      expect(observed.report.ok).toBe(false);
      expect(observed.report.hosts.codex.error).toContain("output exceeded");
      expect(observed.nativeCalls.filter((call) => call.startsWith("codex-attempt:"))).toHaveLength(1);
      expect(existsSync(observed.sentinel)).toBe(false);
      expect(observed.nativeCalls).not.toContain("cleanup-scheduled");
    });
  }
  test("a readback deadline refuses a successful mutation as unverified", () => {
    const observed = run("hang-readback");
    expect(observed.report.ok).toBe(false);
    expect(observed.report.hosts.codex.error).toContain("time budget");
    expect(observed.report.hosts.codex.status).toBe("failed");
    expect(observed.nativeCalls).not.toContain("cleanup-scheduled");
  });
  test("a mutation beyond the query deadline retains its own finite native budget", () => {
    const observed = run("slow-mutation");
    expect(observed.report.ok).toBe(true);
    expect(observed.nativeOptions.map(({ timeout, maxBuffer }) => [timeout, maxBuffer])).toEqual([
      [120000, 2 * 1024 * 1024], [120000, 2 * 1024 * 1024], [5000, 2 * 1024 * 1024],
    ]);
  });
  test("an exhausted whole-operation deadline refuses before another native mutation", () => {
    const observed = run("healthy", { advanceAfterMarketplace: 240001 });
    expect(observed.report.ok).toBe(false);
    expect(observed.report.hosts.codex.error).toContain("time budget");
    expect(observed.nativeCalls.filter((call) => call.startsWith("codex-attempt:"))).toHaveLength(1);
    expect(observed.nativeCalls).not.toContain("cleanup-scheduled");
  });
  test("a timeout flag refuses even a zero-exit mutation without cache-lock recovery", () => {
    const observed = run("healthy", { timedOutMutation: true });
    expect(observed.report.ok).toBe(false);
    expect(observed.report.hosts.codex.error).toContain("time budget");
    expect(observed.nativeCalls.filter((call) => call.startsWith("codex-attempt:"))).toHaveLength(1);
    expect(observed.nativeCalls).not.toContain("cleanup-scheduled");
  });
  test("a small healthy host retains ordinary success", () => {
    expect(run("healthy").report.ok).toBe(true);
  });
  test("an unrelated host failure remains the original command error", () => {
    const observed = run("unrelated-error");
    expect(observed.report.ok).toBe(false);
    expect(observed.report.hosts.codex.error).toContain("owned host failure");
    expect(observed.nativeCalls.filter((call) => call.startsWith("codex-attempt:"))).toHaveLength(1);
  });
});

describe("production Codex JSON metadata refusal", () => {
  const invalid = [
    ["duplicate marketplace identity", '{"name":"foreign","name":"semctx-stable","plugins":[]}'],
    ["escaped equivalent identity", String.raw`{"name":"foreign","\u006eame":"semctx-stable","plugins":[]}`],
    ["duplicate plugin identity", '{"name":"semctx-stable","plugins":[{"name":"foreign","name":"semctx-control",'
      + '"source":{"source":"local","path":"./plugins/semctx-control"}}]}'],
    ["duplicate nested policy", '{"name":"semctx-stable","plugins":[{"name":"semctx-control",'
      + '"source":{"source":"local","path":"./plugins/semctx-control"},'
      + '"policy":{"installation":"NOT_AVAILABLE","installation":"AVAILABLE","products":["CODEX"]}}]}'],
    ["unpaired escaped high surrogate", String.raw`{"name":"semctx-stable","plugins":[],"interface":{"displayName":"\ud800"}}`],
    ["unpaired escaped low surrogate", String.raw`{"name":"semctx-stable","plugins":[],"interface":{"displayName":"\udc00"}}`],
    ["unpaired escaped surrogate key", String.raw`{"name":"semctx-stable","plugins":[],"\ud800":true}`],
  ] as const;

  for (const [name, marketplace] of invalid) {
    test(`${name} refuses default status and installer planning/apply before any native invocation`, () => {
      const status = productionFixture("CODEX_HOME", false, false, "absent", "status", "safe",
        { marketplace }) as ProductionObservation;
      const dryRun = productionFixture("CODEX_HOME", false, false, "absent", "install", "safe",
        { marketplace }) as InstallObservation;
      const apply = productionFixture("CODEX_HOME", false, false, "absent", "install", "safe",
        { marketplace, dryRun: false }) as InstallObservation;
      expect({
        marketplaceConfigured: status.report.hosts.codex.marketplace.configured,
        dryRunStatus: dryRun.report.hosts.codex.status,
        applyStatus: apply.report.hosts.codex.status,
        nativeAttempts: [...dryRun.nativeCalls, ...apply.nativeCalls].filter((call) => call.startsWith("codex-attempt:")),
      }).toEqual({ marketplaceConfigured: null, dryRunStatus: "failed", applyStatus: "failed", nativeAttempts: [] });
      expect(status.report.hosts.codex.reasons).toContain("HOST_QUERY_FAILED");
      expect(apply.report.hosts.codex.error).toContain("declarative plugin metadata safely");
    });
  }

  test("distinct nested scopes, quoted JSON and valid paired/raw Unicode remain admissible", () => {
    const marketplace = JSON.stringify({
      name: "semctx-stable", plugins: [], interface: { displayName: "Emoji 😀" },
      first: { name: "one", items: [{ name: "two" }, { name: "three" }],
        quoted: '{"name":"foreign","name":"semctx-stable"}', escaped: '\\ud800',
        punctuation: '\\"{,}:[]', "é": 1, "e\u0301": 2 },
      second: { name: "four", items: ["name", "name", null, true, -1.2e3] },
    }).replace('"displayName":"Emoji 😀"', String.raw`"displayName":"Emoji \ud83d\ude00"`);
    const status = productionFixture("CODEX_HOME", false, false, "absent", "status", "safe",
      { marketplace }) as ProductionObservation;
    const install = productionFixture("CODEX_HOME", false, false, "absent", "install", "safe",
      { marketplace }) as InstallObservation;
    expect(status.report.hosts.codex.marketplace.configured).toBe(true);
    expect(install.report.ok).toBe(true);
    expect(install.report.hosts.codex.status).toBe("planned");
    expect(install.nativeCalls.some((call) => call.startsWith("codex-attempt:"))).toBe(false);
  });
});

describe("pluginDeliveryStatus production Windows policy authority", () => {
  test.skipIf(process.platform !== "win32")("redirected ProgramData cannot hide the actual known-folder policy", () => {
    const result = productionStatus("CODEX_HOME", false, false, "disabled");
    expect(result.report.hosts.codex.marketplace.configured).toBeNull();
    expect(result.report.hosts.codex.reasons).toContain("HOST_QUERY_FAILED");
    expect(result.nativeCalls).toEqual(["known-folder"]);
  });

  test.skipIf(process.platform !== "win32")("actual system-policy absence is proven only after both known-folder reads", () => {
    const result = productionStatus("CODEX_HOME");
    expect(result.report.hosts.codex.marketplace.configured).toBe(false);
    expect(result.nativeCalls).toEqual(["known-folder", "known-folder"]);
  });

  for (const policy of ["unresolved", "root-drift", "raw-root-drift"] as const) {
    test.skipIf(process.platform !== "win32")(`Windows known-folder ${policy} remains unknown`, () => {
      const result = productionStatus("CODEX_HOME", false, false, policy);
      expect(result.report.hosts.codex.marketplace.configured).toBeNull();
      expect(result.report.hosts.codex.reasons).toContain("HOST_QUERY_FAILED");
    });
  }
});

describe("executeInstall production fallback metadata boundary", () => {
  test("unchanged raw OS home remains a read-only default install plan", () => {
    const result = productionInstall("safe");
    expect(result.report.ok).toBe(true);
    expect(result.report.hosts.codex.status).toBe("planned");
  });

  for (const fault of ["drift", "link", "regular"] as const) {
    test(`raw fallback home ${fault} refuses the default installer callback before host mutation`, () => {
      const result = productionInstall(fault);
      expect(result.report.ok).toBe(false);
      expect(result.report.hosts.codex.status).toBe("failed");
      expect(result.report.hosts.codex.error).toContain("declarative plugin metadata safely");
      expect(result.rawHits).toBeGreaterThan(0);
      expect(result.nativeCalls).not.toContain("codex");
    });
  }

  for (const [policy, reason] of [
    ["temp-root", "WINDOWS_QUERY_TEMP_ROOT_UNAVAILABLE"],
    ["query-nonzero", "WINDOWS_QUERY_EXIT_NONZERO"],
    ["query-timeout", "WINDOWS_QUERY_TIMEOUT"],
    ["query-output-limit", "WINDOWS_QUERY_OUTPUT_LIMIT"],
    ["query-stderr", "WINDOWS_QUERY_STDERR"],
    ["query-output-shape", "WINDOWS_QUERY_OUTPUT_SHAPE"],
    ["query-temp-drift", "WINDOWS_QUERY_TEMP_DRIFT"],
    ["query-profile-drift", "WINDOWS_QUERY_PROFILE_DRIFT"],
    ["query-decode", "WINDOWS_QUERY_DECODE"],
    ["query-path-shape", "WINDOWS_QUERY_PATH_SHAPE"],
  ] as const satisfies readonly (readonly [SystemPolicy, CodexWindowsQueryFailureReason])[]) {
    test.skipIf(process.platform !== "win32")(`Windows known-folder failure reports ${reason}`, () => {
      const result = productionFixture("CODEX_HOME", false, false, policy, "install") as InstallObservation;
      expect(result.report.ok).toBe(false);
      expect(result.report.hosts.codex.error).toContain("cannot inspect Codex declarative plugin metadata safely");
      expect(result.report.hosts.codex.error).toContain(reason);
      expect(result.report.hosts.codex.error).not.toContain("secret-");
    });
  }

  test.skipIf(process.platform === "win32")("non-Windows known-folder resolution emits no Windows reason", () => {
    let reason: CodexWindowsQueryFailureReason | undefined;
    expect(resolveCodexWindowsProgramData(undefined, (value) => { reason = value; })).toBeNull();
    expect(reason).toBeUndefined();
  });
});
