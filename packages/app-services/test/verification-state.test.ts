import { afterEach, spyOn, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SemctxError } from "@semantic-context/core";
import {
  __setVerificationAttributeBarrierForTesting,
  captureRecordableVerificationGitState,
  captureVerificationGitState,
  retainedGitBlobObjectIds,
} from "../src/verification-state";

const roots: string[] = [];

function captureWithProcessCount(root: string) {
  const spawn = spyOn(Bun, "spawnSync");
  try {
    const state = captureVerificationGitState(root);
    const hashObjectCalls = spawn.mock.calls.filter(([command]) =>
      Array.isArray(command) && command[0] === "git" && command[1] === "hash-object",
    ).length;
    return { state, hashObjectCalls };
  } finally {
    spawn.mockRestore();
  }
}

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(
    ["git", "-c", "user.name=Semctx Test", "-c", "user.email=semctx@example.test", ...args],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout).trim();
}

/** Real, independent Git process used as the oracle for a single blob id. Never call the
 *  implementation's own hashing helpers here — that would make the test circular. */
function realHashObject(root: string, path: string, payload: Uint8Array): string {
  const result = Bun.spawnSync(["git", "hash-object", `--path=${path}`, "--stdin"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    stdin: payload,
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout).trim();
}

/** Independently reconstructed framing of `semctx:verification-repository-state:v1`, so the
 *  expected value is never produced by calling the implementation's own private helper. */
function frameBytes(label: string, payload: Uint8Array | string): Uint8Array {
  const bytes = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
  const header = new TextEncoder().encode(`${label}\0${bytes.byteLength}\0`);
  const combined = new Uint8Array(header.byteLength + bytes.byteLength);
  combined.set(header, 0);
  combined.set(bytes, header.byteLength);
  return combined;
}

function expectedRepositoryStateHash(entries: Array<{ path: string; mode: string; objectId: string }>): string {
  const ordered = [...entries].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const hash = createHash("sha256");
  hash.update(frameBytes("domain", "semctx:verification-repository-state:v1"));
  for (const entry of ordered) {
    hash.update(frameBytes("path", entry.path));
    hash.update(frameBytes("mode", entry.mode));
    hash.update(frameBytes("object", entry.objectId));
  }
  return `sha256:${hash.digest("hex")}`;
}

/** Empty initial commit: every fixture below adds exactly the tracked paths it asserts on, so the
 *  oracle never has to account for an unrelated placeholder file. */
function repository(objectFormat?: "sha256"): string {
  const root = mkdtempSync(join(tmpdir(), "semctx-verification-state-"));
  roots.push(root);
  git(root, "init", "-q", ...(objectFormat === undefined ? [] : [`--object-format=${objectFormat}`]));
  git(root, "commit", "-q", "--allow-empty", "-m", "empty");
  return root;
}

function configureCleanFilter(root: string, name: string, script: string): string {
  const scriptPath = join(root, ".git", `${name}.cjs`).replaceAll("\\", "/");
  writeFileSync(join(root, ".git", `${name}.cjs`), script);
  const executable = process.execPath.replaceAll("\\", "/");
  return `"${executable}" "${scriptPath}"`;
}

afterEach(() => {
  __setVerificationAttributeBarrierForTesting(undefined);
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("local blob object id derivation", () => {
  for (const conversion of ["crlf", "encoding", "filter", "identity"] as const) it(`retained post-image ${conversion} uses selected attributes and retained payload, never live content`, () => {
    const root = repository(); const name = "input.dat";
    const bytes = conversion === "encoding" ? Buffer.from("retained content\n", "utf16le") : Buffer.from(conversion === "crlf" ? "retained content\r\n" : "retained content\n");
    const attributes = conversion === "encoding" ? `${name} working-tree-encoding=UTF-16LE\n` : conversion === "crlf" ? `${name} text eol=crlf\n` : conversion === "filter" ? `${name} filter=upper\n` : "";
    if (conversion === "filter") git(root, "config", "filter.upper.clean", configureCleanFilter(root, "retained-upper", "let chunks=[];process.stdin.on('data',c=>chunks.push(c));process.stdin.on('end',()=>process.stdout.write(Buffer.concat(chunks).toString('utf8').toUpperCase()));"));
    writeFileSync(join(root, ".gitattributes"), attributes); writeFileSync(join(root, name), bytes);
    git(root, "add", "."); git(root, "commit", "-qm", "selected input");
    const head = git(root, "rev-parse", "HEAD"); const expected = git(root, "rev-parse", `HEAD:${name}`);
    writeFileSync(join(root, name), "different live source\n"); writeFileSync(join(root, ".gitattributes"), `${name} -text -filter -working-tree-encoding\n`);
    expect(retainedGitBlobObjectIds(root, head, [{ path: name, bytes }]).get(name)).toBe(expected);
  });
  it("retained post-image refuses attribute context drift between observations", () => {
    const root = repository(); const name = "input.dat";
    const head = git(root, "rev-parse", "HEAD");
    __setVerificationAttributeBarrierForTesting(() => writeFileSync(join(root, ".git/info/attributes"), `${name} ident\n`));
    expect(() => retainedGitBlobObjectIds(root, head, [{ path: name, bytes: Buffer.from("retained\n") }])).toThrow("attribute metadata changed");
  });
  for (const override of ["-text", "eol=crlf"]) it(`retained post-image refuses text/eol conversion drift: ${override}`, () => {
    const root = repository(); const name = "input.dat";
    writeFileSync(join(root, ".gitattributes"), `${name} text eol=lf\n`);
    git(root, "add", ".gitattributes"); git(root, "commit", "-qm", "selected attributes");
    const head = git(root, "rev-parse", "HEAD");
    __setVerificationAttributeBarrierForTesting(() => writeFileSync(join(root, ".git/info/attributes"), `${name} ${override}\n`));
    expect(() => retainedGitBlobObjectIds(root, head, [{ path: name, bytes: Buffer.from("retained\r\n") }])).toThrow("attribute metadata changed");
  });
  it("matches the real Git oracle in a SHA-256 repository", () => {
    const root = repository("sha256");
    const name = "espace été.txt";
    writeFileSync(join(root, name), "UTF-8 : été\n");
    git(root, "add", ".");
    const { state, hashObjectCalls } = captureWithProcessCount(root);
    const objectId = realHashObject(root, name, readFileSync(join(root, name)));
    expect(objectId.length).toBe(64);
    expect(state.repositoryStateHash).toBe(expectedRepositoryStateHash([{ path: name, mode: "100644", objectId }]));
    expect(hashObjectCalls).toBe(0);
  });
  it("matches an independent Git oracle for many LF-only files without spawning git hash-object", () => {
    const root = repository();
    const files = Array.from({ length: 15 }, (_, index) => `file-${index}.txt`);
    for (const name of files) {
      writeFileSync(join(root, name), `content for ${name}\nsecond line\n`);
    }
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "many lf files");

      const { state, hashObjectCalls } = captureWithProcessCount(root);

    expect(hashObjectCalls).toBe(0);
    const entries = files.map((name) => ({
      path: name,
      mode: "100644",
      objectId: realHashObject(root, name, readFileSync(join(root, name))),
    }));
    expect(state.repositoryStateHash).toBe(expectedRepositoryStateHash(entries));
  }, 20_000);

  it("matches the oracle for an empty file and a binary file with no CR byte", () => {
    const root = repository();
    writeFileSync(join(root, "empty.bin"), Buffer.alloc(0));
    writeFileSync(join(root, "binary.bin"), Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x0a, 0x00]));
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "binary fixtures");

      const { state, hashObjectCalls } = captureWithProcessCount(root);

    expect(hashObjectCalls).toBe(0);
    const entries = ["empty.bin", "binary.bin"].map((name) => ({
      path: name,
      mode: "100644",
      objectId: realHashObject(root, name, readFileSync(join(root, name))),
    }));
    expect(state.repositoryStateHash).toBe(expectedRepositoryStateHash(entries));
  });
});

describe("conversion fallback", () => {
  for (const filter of ["unset", "unspecified"] as const) {
    it(`preserves a clean filter with the reserved-looking name ${filter}`, () => {
      const root = repository();
      const name = "reserved.txt";
      git(root, "config", `filter.${filter}.clean`, configureCleanFilter(root, "reserved-clean",
        "let s = ''; process.stdin.on('data', c => s += c); process.stdin.on('end', () => process.stdout.write(s.toUpperCase()));"));
      writeFileSync(join(root, ".gitattributes"), `${name} filter=${filter}\n`);
      writeFileSync(join(root, name), "lowercase\n");
      git(root, "add", ".");
      const state = captureVerificationGitState(root);
      const entries = [".gitattributes", name].map((path) => ({
        path, mode: "100644", objectId: realHashObject(root, path, readFileSync(join(root, path))),
      }));
      expect(state.repositoryStateHash).toBe(expectedRepositoryStateHash(entries));
    });
  }
  it("falls back to git hash-object for CR-bearing content and matches the real Git object id", () => {
    const root = repository();
    const name = "crlf.txt";
    writeFileSync(join(root, name), "line one\r\nline two\r\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "crlf file");

      const { state, hashObjectCalls } = captureWithProcessCount(root);

    expect(hashObjectCalls).toBe(1);
    const objectId = realHashObject(root, name, readFileSync(join(root, name)));
    expect(state.repositoryStateHash).toBe(expectedRepositoryStateHash([{ path: name, mode: "100644", objectId }]));
  }, 20_000);

  it("falls back to git hash-object when the ident attribute is active, even with LF-only content", () => {
    const root = repository();
    const name = "ident.txt";
    writeFileSync(join(root, ".gitattributes"), `${name} ident\n`);
    writeFileSync(join(root, name), "$Id: expanded value $\nbody\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "ident file");

      const { state, hashObjectCalls } = captureWithProcessCount(root);

    expect(hashObjectCalls).toBe(1);
    const entries = [
      { path: name, mode: "100644", objectId: realHashObject(root, name, readFileSync(join(root, name))) },
      {
        path: ".gitattributes",
        mode: "100644",
        objectId: realHashObject(root, ".gitattributes", readFileSync(join(root, ".gitattributes"))),
      },
    ];
    expect(state.repositoryStateHash).toBe(expectedRepositoryStateHash(entries));
  }, 20_000);

  it("falls back to git hash-object when a custom clean filter is configured, matching the real Git conversion", () => {
    const root = repository();
    const name = "upper.dat";
    const command = configureCleanFilter(
      root,
      "semctx-upper-clean",
      [
        "let chunks = [];",
        "process.stdin.on('data', (chunk) => chunks.push(chunk));",
        "process.stdin.on('end', () => process.stdout.write(Buffer.concat(chunks).toString('utf8').toUpperCase()));",
      ].join("\n"),
    );
    git(root, "config", "filter.upper.clean", command);
    writeFileSync(join(root, ".gitattributes"), `${name} filter=upper\n`);
    writeFileSync(join(root, name), "lowercase content\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "filtered file");

      const { state, hashObjectCalls } = captureWithProcessCount(root);

    expect(hashObjectCalls).toBe(1);
    const entries = [
      { path: name, mode: "100644", objectId: realHashObject(root, name, readFileSync(join(root, name))) },
      {
        path: ".gitattributes",
        mode: "100644",
        objectId: realHashObject(root, ".gitattributes", readFileSync(join(root, ".gitattributes"))),
      },
    ];
    expect(state.repositoryStateHash).toBe(expectedRepositoryStateHash(entries));
  }, 20_000);

  it("surfaces the same Git error as before when a required clean filter fails", () => {
    const root = repository();
    const name = "broken.dat";
    const command = configureCleanFilter(root, "semctx-broken-clean", "process.exit(1);\n");
    git(root, "config", "filter.broken.clean", command);
    writeFileSync(join(root, ".gitattributes"), `${name} filter=broken\n`);
    writeFileSync(join(root, name), "payload\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "broken filter file");
    git(root, "config", "filter.broken.required", "true");

    let error: unknown;
    try {
      captureVerificationGitState(root);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SemctxError);
    expect((error as SemctxError).code).toBe("GIT_ERROR");
  }, 20_000);

  it("falls back to git hash-object when working-tree-encoding is active, matching the real Git conversion", () => {
    const root = repository();
    const name = "encoded.txt";
    writeFileSync(join(root, ".gitattributes"), `${name} working-tree-encoding=UTF-16LE\n`);
    writeFileSync(join(root, name), Buffer.from("hello\nworld\n", "utf16le"));
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "encoded file");

      const { state, hashObjectCalls } = captureWithProcessCount(root);

    expect(hashObjectCalls).toBe(1);
    const entries = [
      { path: name, mode: "100644", objectId: realHashObject(root, name, readFileSync(join(root, name))) },
      {
        path: ".gitattributes",
        mode: "100644",
        objectId: realHashObject(root, ".gitattributes", readFileSync(join(root, ".gitattributes"))),
      },
    ];
    expect(state.repositoryStateHash).toBe(expectedRepositoryStateHash(entries));
  }, 20_000);
});

describe("hidden bytes and attribute drift", () => {
  for (const phase of ["initial", "reobserved"] as const) {
    for (const fault of ["missing", "duplicate", "extra", "unterminated", "failed"] as const) {
      it(`refuses ${phase} ${fault} attribute metadata`, () => {
        const root = repository();
        writeFileSync(join(root, "plain.txt"), "stable\n");
        git(root, "add", ".");
        const original = Bun.spawnSync;
        let attrCalls = 0;
        const spy = spyOn(Bun, "spawnSync").mockImplementation((...args) => {
          const [command] = args;
          const result = Reflect.apply(original, Bun, args) as ReturnType<typeof Bun.spawnSync>;
          if (Array.isArray(command) && command[1] === "check-attr" && !command.includes("--all")) {
            attrCalls++;
            if (attrCalls === (phase === "initial" ? 1 : 2)) {
              if (result.stdout === undefined) throw new Error("expected piped check-attr output");
              const output = result.stdout.toString();
              const stdout = fault === "missing" ? ""
                : fault === "duplicate" ? output + output
                : fault === "extra" ? `${output}other.txt\0filter\0unspecified\0`
                : fault === "unterminated" ? output.slice(0, -1) : output;
              return { ...result, stdout: Buffer.from(stdout), exitCode: fault === "failed" ? 1 : result.exitCode };
            }
          }
          return result;
        });
        try {
          expect(() => captureVerificationGitState(root)).toThrow(SemctxError);
          expect(attrCalls).toBe(phase === "initial" ? 1 : 2);
        } finally {
          spy.mockRestore();
        }
      });
    }
  }
  it("still detects a skip-worktree edit hidden from the diff after the fast path resolves its blob id locally", () => {
    const root = repository();
    const name = "hidden.txt";
    writeFileSync(join(root, name), "original\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "hidden fixture");
    git(root, "update-index", "--skip-worktree", name);
    writeFileSync(join(root, name), "mutated\n");

    let error: unknown;
    try {
      captureRecordableVerificationGitState(root);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SemctxError);
    expect((error as SemctxError).code).toBe("INVALID_TASK_INPUT");
    expect((error as SemctxError).details.hiddenTrackedPaths).toEqual([name]);
  }, 20_000);

  it("refuses the capture when check-attr metadata drifts between the initial and reobserved snapshot", () => {
    const root = repository();
    const name = "drift.txt";
    writeFileSync(join(root, name), "stable content\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "drift fixture");

    __setVerificationAttributeBarrierForTesting(() => {
      writeFileSync(join(root, ".gitattributes"), `${name} ident\n`);
    });

    let error: unknown;
    try {
      captureVerificationGitState(root);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SemctxError);
    expect((error as SemctxError).code).toBe("GIT_ERROR");
    expect((error as SemctxError).message).toContain("attribute metadata changed during capture");
  }, 20_000);
});
