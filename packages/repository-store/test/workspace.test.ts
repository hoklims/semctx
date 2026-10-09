import { afterEach, describe, expect, expectTypeOf, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultConfig, createGlobSelectionConfig } from "@semantic-context/core";
import type { SemctxConfig, SemctxConfigV1, SemctxConfigV2 } from "@semantic-context/core";
import { initWorkspace, loadConfig, openReader, openStore, saveConfig, toDiskConfig } from "../src/workspace";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "semctx-workspace-"));
  roots.push(root);
  return root;
}

describe("disk config projection types (#243)", () => {
  it("preserves the v1 variant without repositoryRoot", () => {
    const policy = toDiskConfig(createDefaultConfig(tempRoot()));

    expectTypeOf(policy).toEqualTypeOf<Omit<SemctxConfigV1, "repositoryRoot">>();
    expectTypeOf(policy.version).toEqualTypeOf<1>();
    expectTypeOf(policy).not.toHaveProperty("repositoryRoot");
    expectTypeOf(policy).not.toHaveProperty("selectionMode");
    expectTypeOf(policy).not.toHaveProperty("languages");
  });

  it("preserves the v2 variant without repositoryRoot", () => {
    const policy = toDiskConfig(createGlobSelectionConfig(tempRoot()));

    expectTypeOf(policy).toEqualTypeOf<Omit<SemctxConfigV2, "repositoryRoot">>();
    expectTypeOf(policy.version).toEqualTypeOf<2>();
    expectTypeOf(policy.selectionMode).toEqualTypeOf<"globs-v1">();
    expectTypeOf(policy.languages).toEqualTypeOf<SemctxConfigV2["languages"]>();
    expectTypeOf(policy).not.toHaveProperty("repositoryRoot");
  });

  it("preserves a discriminated v1 | v2 union without repositoryRoot", () => {
    const root = tempRoot();
    const configs: SemctxConfig[] = [createDefaultConfig(root), createGlobSelectionConfig(root)];

    for (const config of configs) {
      const policy = toDiskConfig(config);

      expectTypeOf(policy).toEqualTypeOf<
        Omit<SemctxConfigV1, "repositoryRoot"> | Omit<SemctxConfigV2, "repositoryRoot">
      >();
      expectTypeOf(policy).not.toHaveProperty("repositoryRoot");
      if (policy.version === 2) {
        expectTypeOf(policy).toEqualTypeOf<Omit<SemctxConfigV2, "repositoryRoot">>();
        expectTypeOf(policy.selectionMode).toEqualTypeOf<"globs-v1">();
        expectTypeOf(policy.languages).toEqualTypeOf<SemctxConfigV2["languages"]>();
      } else {
        expectTypeOf(policy).toEqualTypeOf<Omit<SemctxConfigV1, "repositoryRoot">>();
        expectTypeOf(policy).not.toHaveProperty("selectionMode");
        expectTypeOf(policy).not.toHaveProperty("languages");
      }
    }
  });
});

describe("uninitialized workspace refusal", () => {
  it("refuses reader and writer opens without creating .semctx", () => {
    const root = tempRoot();

    for (const open of [openReader, openStore]) {
      let caught: unknown;
      try {
        open(root);
      } catch (error) {
        caught = error;
      }
      expect((caught as { code?: string } | undefined)?.code).toBe("CONFIG_NOT_FOUND");
      expect(existsSync(join(root, ".semctx"))).toBe(false);
    }
  });

  it("refuses a direct config save without creating .semctx", () => {
    const root = tempRoot();
    let caught: unknown;
    try {
      saveConfig(root, createDefaultConfig(root));
    } catch (error) {
      caught = error;
    }

    expect((caught as { code?: string } | undefined)?.code).toBe("CONFIG_NOT_FOUND");
    expect(existsSync(join(root, ".semctx"))).toBe(false);
  });
});

describe("config persistence (#82)", () => {
  it("does not write repositoryRoot to config.json", () => {
    const root = tempRoot();
    initWorkspace(root);
    const onDisk = JSON.parse(readFileSync(join(root, ".semctx", "config.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(onDisk).not.toHaveProperty("repositoryRoot");
    expect(onDisk.version).toBe(1);
    expect(Array.isArray(onDisk.include)).toBe(true);
  });

  it("loads policy without repositoryRoot and injects the call root", () => {
    const root = tempRoot();
    const policy = createDefaultConfig(root);
    initWorkspace(root, policy);
    const raw = JSON.parse(readFileSync(join(root, ".semctx", "config.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(raw).not.toHaveProperty("repositoryRoot");
    expect(raw.include).toEqual(policy.include);

    const loaded = loadConfig(root);
    expect(loaded.repositoryRoot).toBe(realpathSync.native(root));
    expect(loaded.include).toEqual(policy.include);
  });

  it("ignores a legacy absolute repositoryRoot on disk", () => {
    const root = tempRoot();
    const config = createDefaultConfig(root);
    initWorkspace(root, config);
    const path = join(root, ".semctx", "config.json");
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    raw.repositoryRoot = "/some/other/machine/path";
    writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");

    const loaded = loadConfig(root);
    expect(loaded.repositoryRoot).toBe(realpathSync.native(root));
    expect(loaded.repositoryRoot).not.toBe("/some/other/machine/path");
  });

  it("ignores empty-string and relative legacy repositoryRoot values", () => {
    const root = tempRoot();
    initWorkspace(root, createDefaultConfig(root));
    const path = join(root, ".semctx", "config.json");
    for (const legacy of ["", "."] as const) {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      raw.repositoryRoot = legacy;
      writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
      const loaded = loadConfig(root);
      expect(loaded.repositoryRoot).toBe(realpathSync.native(root));
    }
  });

  it("load then save still omits repositoryRoot", () => {
    const root = tempRoot();
    initWorkspace(root);
    const loaded = loadConfig(root);
    expect(loaded.repositoryRoot).toBe(realpathSync.native(root));
    saveConfig(root, loaded);
    const again = JSON.parse(readFileSync(join(root, ".semctx", "config.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(again).not.toHaveProperty("repositoryRoot");
  });

  it("preserves version 2 selection policy while omitting repositoryRoot", () => {
    const root = tempRoot();
    const config = createGlobSelectionConfig(root);
    const policy = toDiskConfig(config);

    // This access also proves at compile time that the helper preserves the v2 subtype.
    expect(policy.selectionMode).toBe("globs-v1");
    expect(policy.languages).toEqual(config.languages);

    initWorkspace(root, config);
    const onDisk = JSON.parse(
      readFileSync(join(root, ".semctx", "config.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(onDisk).not.toHaveProperty("repositoryRoot");
    expect(onDisk.version).toBe(2);
    expect(onDisk.selectionMode).toBe("globs-v1");
    expect(onDisk.languages).toEqual(config.languages);
  });
});

/** A clone is the same committed bytes checked out at a different absolute path. */
describe("shareable config across clones (#82)", () => {
  // Return type is inferred from `readFileSync` so the byte comparison below keeps its exact
  // buffer type (an explicit `Buffer` widens to `ArrayBufferLike` and breaks `toEqual`).
  function cloneConfig(from: string, to: string) {
    const bytes = readFileSync(join(from, ".semctx", "config.json"));
    mkdirSync(join(to, ".semctx"), { recursive: true });
    writeFileSync(join(to, ".semctx", "config.json"), bytes);
    return bytes;
  }

  it("drives two distinct repository paths from one byte-identical config", () => {
    const alpha = tempRoot();
    const beta = tempRoot();
    expect(realpathSync.native(alpha)).not.toBe(realpathSync.native(beta));

    initWorkspace(alpha, { include: ["packages/*/src/**/*.ts"], docsDirs: ["handbook"] });
    const shared = cloneConfig(alpha, beta);
    expect(readFileSync(join(beta, ".semctx", "config.json"))).toEqual(shared);

    const fromAlpha = loadConfig(alpha);
    const fromBeta = loadConfig(beta);

    // Each clone resolves its own canonical root from the call, not from the file.
    expect(fromAlpha.repositoryRoot).toBe(realpathSync.native(alpha));
    expect(fromBeta.repositoryRoot).toBe(realpathSync.native(beta));
    expect(fromBeta.repositoryRoot).not.toBe(fromAlpha.repositoryRoot);
    // Everything else — the shared policy — is identical.
    expect(toDiskConfig(fromBeta)).toEqual(toDiskConfig(fromAlpha));
    expect(fromBeta.include).toEqual(["packages/*/src/**/*.ts"]);
    expect(fromBeta.docsDirs).toEqual(["handbook"]);
  });

  it("recovers a legacy clone whose config still names another machine's root", () => {
    // The exact #82 failure: the old writer persisted an absolute root that no other clone shares.
    const alpha = tempRoot();
    const beta = tempRoot();
    initWorkspace(alpha);

    const legacy = JSON.parse(
      readFileSync(join(alpha, ".semctx", "config.json"), "utf8"),
    ) as Record<string, unknown>;
    legacy.repositoryRoot = realpathSync.native(alpha);
    mkdirSync(join(beta, ".semctx"), { recursive: true });
    writeFileSync(join(beta, ".semctx", "config.json"), `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

    const loaded = loadConfig(beta);
    expect(loaded.repositoryRoot).toBe(realpathSync.native(beta));
    expect(loaded.repositoryRoot).not.toBe(legacy.repositoryRoot);

    // Rewriting the clone's config sheds the stale field instead of propagating it.
    saveConfig(beta, loaded);
    const rewritten = JSON.parse(
      readFileSync(join(beta, ".semctx", "config.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(rewritten).not.toHaveProperty("repositoryRoot");
  });
});
