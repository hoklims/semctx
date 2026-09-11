import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { buildPagesArtifact } from "../build-pages-artifact";

const temporaryDirectories: string[] = [];

function write(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "semctx-pages-artifact-"));
  temporaryDirectories.push(root);
  write(root, "site/landing/index.html", "landing");
  for (const file of ["index.html", "app.js", "styles.css", "favicon.svg", "evidence.json"]) {
    write(root, `site/${file}`, `demo:${file}`);
  }
  write(root, "site/fixtures/tsconfig.json", "{}");
  write(root, "site/fixtures/base/src/greeting.ts", "base");
  write(root, "site/fixtures/changed/src/greeting.ts", "changed");
  return root;
}

function files(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
    .sort();
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Pages artifact builder", () => {
  test("creates the exact root landing and complete recursive demo tree", () => {
    const root = fixture();
    const output = buildPagesArtifact({ repositoryRoot: root });

    expect(files(output)).toEqual([
      "demo/app.js",
      "demo/evidence.json",
      "demo/favicon.svg",
      "demo/fixtures/base/src/greeting.ts",
      "demo/fixtures/changed/src/greeting.ts",
      "demo/fixtures/tsconfig.json",
      "demo/index.html",
      "demo/styles.css",
      "index.html",
    ]);
    expect(readFileSync(join(output, "index.html"), "utf8")).toBe("landing");
    expect(readFileSync(join(output, "demo/index.html"), "utf8")).toBe("demo:index.html");
  });

  test("fails before publishing when a required input is missing", () => {
    const root = fixture();
    rmSync(join(root, "site/evidence.json"));

    expect(() => buildPagesArtifact({ repositoryRoot: root })).toThrow("Pages demo input evidence.json is missing");
    expect(existsSync(join(root, "_site"))).toBe(false);
    expect(readdirSync(root).some((entry) => entry.startsWith("._site-staging-"))).toBe(false);
  });

  test("refuses stale output without deleting or overwriting it", () => {
    const root = fixture();
    write(root, "_site/stale-marker.txt", "keep me");

    expect(() => buildPagesArtifact({ repositoryRoot: root })).toThrow("refusing to overwrite stale content");
    expect(readFileSync(join(root, "_site/stale-marker.txt"), "utf8")).toBe("keep me");
    expect(readdirSync(root).some((entry) => entry.startsWith("._site-staging-"))).toBe(false);
  });
});
