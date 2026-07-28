import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig, SemctxError, type SemctxConfigV2 } from "@semantic-context/core";
import { dbPath, initWorkspace } from "@semantic-context/repository-store";
import {
  __setIndexRepositoryCaptureBarrierForTesting,
  indexRepository,
} from "../src/indexing";

const roots: string[] = [];

function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}

function repository(manifest: "package.json" | "pyproject.toml" = "package.json"): {
  root: string;
  sourcePath: string;
  configPath: string;
  manifestPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), "semctx-indexing-toctou-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  const sourcePath = join(root, "src", "service.ts");
  const manifestPath = join(root, manifest);
  const configPath = join(root, ".semctx", "config.json");

  writeFileSync(
    sourcePath,
    [
      "export function service(): number {",
      "  return 1;",
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(
    manifestPath,
    manifest === "package.json"
      ? `${JSON.stringify({ name: "fixture-before" }, null, 2)}\n`
      : '[project]\nname = "fixture-before"\n',
  );
  writeFileSync(join(root, ".gitignore"), ".semctx/\n");
  git(root, "init", "-q");
  git(root, "add", ".");
  git(
    root,
    "-c",
    "user.name=Semctx Test",
    "-c",
    "user.email=semctx@example.test",
    "commit",
    "-q",
    "-m",
    "fixture",
  );

  const config: SemctxConfigV2 = {
    ...createGlobSelectionConfig(root),
    include: ["src/**/*.ts"],
  };
  initWorkspace(root, config);
  indexRepository(root, "2026-07-28T11:00:00.000Z");

  return { root, sourcePath, configPath, manifestPath };
}

function expectRejectedWithoutReplacingSnapshot(
  root: string,
  mutateDuringCapture: () => void,
): SemctxError {
  const priorDatabase = readFileSync(dbPath(root));
  __setIndexRepositoryCaptureBarrierForTesting(mutateDuringCapture);

  let thrown: unknown;
  try {
    indexRepository(root, "2026-07-28T11:01:00.000Z");
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(SemctxError);
  expect(thrown).toMatchObject({
    code: "GIT_ERROR",
    message: "repository inputs changed while the index was being built",
  });
  expect(readFileSync(dbPath(root))).toEqual(priorDatabase);
  return thrown as SemctxError;
}

afterEach(() => {
  __setIndexRepositoryCaptureBarrierForTesting(undefined);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("indexRepository time-of-check/time-of-use protection", () => {
  it("rejects selected source drift and preserves the previous snapshot", () => {
    const { root, sourcePath } = repository();
    git(root, "update-index", "--assume-unchanged", "src/service.ts");

    const error = expectRejectedWithoutReplacingSnapshot(root, () => {
      writeFileSync(
        sourcePath,
        [
          "export function service(): number {",
          "  return 2;",
          "}",
          "",
        ].join("\n"),
      );
    });

    expect(error.details.before).toEqual(error.details.after);
    expect(error.details.analysisInputHash).not.toBe(error.details.analysisInputHashAfter);
    expect(error.details.discoveryLedgerDigest).toBe(error.details.discoveryLedgerDigestAfter);
    expect(error.details.workspaceProjectionDigest)
      .toBe(error.details.workspaceProjectionDigestAfter);
  });

  it("rejects .semctx/config.json drift and preserves the previous snapshot", () => {
    const { root, configPath } = repository();

    const error = expectRejectedWithoutReplacingSnapshot(root, () => {
      const config = JSON.parse(readFileSync(configPath, "utf8")) as SemctxConfigV2;
      writeFileSync(
        configPath,
        `${JSON.stringify({ ...config, docsDirs: [...config.docsDirs, "notes"] }, null, 2)}\n`,
      );
    });

    expect(error.details.before).toEqual(error.details.after);
    expect(error.details.analysisInputHash).not.toBe(error.details.analysisInputHashAfter);
    expect(error.details.discoveryLedgerDigest).toBe(error.details.discoveryLedgerDigestAfter);
    expect(error.details.workspaceProjectionDigest)
      .toBe(error.details.workspaceProjectionDigestAfter);
  });

  for (const manifest of ["package.json", "pyproject.toml"] as const) {
    it(`rejects ${manifest} drift and preserves the previous snapshot`, () => {
      const { root, manifestPath } = repository(manifest);
      git(root, "update-index", "--assume-unchanged", manifest);

      const error = expectRejectedWithoutReplacingSnapshot(root, () => {
        writeFileSync(
          manifestPath,
          manifest === "package.json"
            ? `${JSON.stringify({ name: "fixture-after" }, null, 2)}\n`
            : '[project]\nname = "fixture-after"\n',
        );
      });

      expect(error.details.before).toEqual(error.details.after);
      expect(error.details.analysisInputHash).toBe(error.details.analysisInputHashAfter);
      expect(error.details.discoveryLedgerDigest).toBe(error.details.discoveryLedgerDigestAfter);
      expect(error.details.workspaceProjectionDigest)
        .not.toBe(error.details.workspaceProjectionDigestAfter);
    });
  }
});
