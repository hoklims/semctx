import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseObservedDiffHunks,
  parseUnifiedDiffBytes,
} from "@semantic-context/context-engine";
import { frameObservedDiffHunkV1 } from "@semantic-context/control-model";

const FIXTURES = join(import.meta.dir, "fixtures", "plane-a");
const encoder = new TextEncoder();

describe("parseObservedDiffHunks", () => {
  it("matches the normative frame and coordinate from physical fixture bytes", () => {
    const diffBytes = readFileSync(join(FIXTURES, "l0-normative.patch"));
    const hunks = parseObservedDiffHunks({
      repositoryIdentity: "repo:semctx",
      diffBytes,
    });

    expect(hunks).toHaveLength(1);
    const hunk = hunks[0]!;
    expect(hunk).toMatchObject({
      schemaVersion: 1,
      repositoryIdentity: "repo:semctx",
      normalizedPath: "packages/demo.txt",
      oldRange: { start: 1, lines: 2 },
      newRange: { start: 1, lines: 2 },
      oldBlobId: null,
      newBlobId: "abc123",
      identity: "sha256:8e5c558849431b16e62d642bda29b2d82c26030eb6c9cc1bbed19bab37284562",
    });
    expect(hunk.rawHunkBytes).toEqual(
      encoder.encode("@@ -1,2 +1,2 @@\n-old\n+new\n keep\n"),
    );
    expect(Buffer.from(frameObservedDiffHunkV1(hunk)).toString("hex")).toBe(
      "53454d4354584c30000000010000000b7265706f3a73656d637478000000117061636b616765732f64656d6f2e74787400000001000000020000000100000002000100000006616263313233000000204040202d312c32202b312c322040400a2d6f6c640a2b6e65770a206b6565700a",
    );
  });

  it("preserves Unicode and line-ending bytes while normalizing only the path", () => {
    const lfBytes = readFileSync(join(FIXTURES, "l0-unicode-lf.patch"));
    const crlfBytes = Buffer.from(lfBytes.toString("utf8").replaceAll("\n", "\r\n"), "utf8");

    const lf = parseObservedDiffHunks({
      repositoryIdentity: "repo:semctx",
      diffBytes: lfBytes,
    })[0]!;
    const crlf = parseObservedDiffHunks({
      repositoryIdentity: "repo:semctx",
      diffBytes: crlfBytes,
    })[0]!;

    expect(lf.normalizedPath).toBe("packages/café.txt");
    expect(crlf.normalizedPath).toBe("packages/café.txt");
    expect(lf.rawHunkBytes).toEqual(
      encoder.encode("@@ -4,1 +4,1 @@ contexte\n-café\n+café\n"),
    );
    expect(crlf.rawHunkBytes).toEqual(
      encoder.encode("@@ -4,1 +4,1 @@ contexte\r\n-café\r\n+café\r\n"),
    );
    expect(lf.identity).not.toBe(crlf.identity);
  });

  it("canonicalizes Windows-shaped relative paths before identity framing", () => {
    const bytes = encoder.encode(
      "diff --git a/x b/x\n"
      + "--- a/x\n"
      + "+++ b/packages\\café.txt\n"
      + "@@ -1 +1 @@\n"
      + "-a\n"
      + "+b\n",
    );
    const hunk = parseObservedDiffHunks({
      repositoryIdentity: "repo:x",
      diffBytes: bytes,
    })[0]!;
    expect(hunk.normalizedPath).toBe("packages/café.txt");
    expect(hunk.identity).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("returns deterministic path/range/identity order", () => {
    const first = encoder.encode(
      "diff --git a/z.ts b/z.ts\nindex 111..222 100644\n--- a/z.ts\n+++ b/z.ts\n@@ -9 +9 @@\n-a\n+b\n"
      + "diff --git a/a.ts b/a.ts\nindex 333..444 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -2 +2 @@\n-c\n+d\n",
    );

    const once = parseObservedDiffHunks({ repositoryIdentity: "repo:x", diffBytes: first });
    const twice = parseObservedDiffHunks({ repositoryIdentity: "repo:x", diffBytes: first });

    expect(once.map((hunk) => hunk.normalizedPath)).toEqual(["a.ts", "z.ts"]);
    expect(once.map((hunk) => hunk.identity)).toEqual(twice.map((hunk) => hunk.identity));
  });

  it("handles deletions, multiple hunks, zero ranges, and no-newline markers", () => {
    const bytes = encoder.encode(
      "diff --git a/gone.ts b/gone.ts\n"
      + "deleted file mode 100644\n"
      + "index abcdef0..0000000\n"
      + "--- a/gone.ts\n"
      + "+++ /dev/null\n"
      + "@@ -1,2 +0,0 @@\n"
      + "---- looks like a file header\n"
      + "-last"
      + "\n\\ No newline at end of file\n"
      + "@@ -8,0 +6,1 @@\n"
      + "+unreachable-but-valid-second-hunk\n",
    );

    const hunks = parseObservedDiffHunks({
      repositoryIdentity: "repo:x",
      diffBytes: bytes,
    });

    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({
      normalizedPath: "gone.ts",
      oldRange: { start: 1, lines: 2 },
      newRange: { start: 0, lines: 0 },
      oldBlobId: "abcdef0",
      newBlobId: null,
    });
    expect(hunks[0]!.rawHunkBytes).toEqual(encoder.encode(
      "@@ -1,2 +0,0 @@\n"
      + "---- looks like a file header\n"
      + "-last\n"
      + "\\ No newline at end of file\n",
    ));
    expect(hunks[1]).toMatchObject({
      oldRange: { start: 8, lines: 0 },
      newRange: { start: 6, lines: 1 },
    });
  });

  it("rejects absolute, escaping, empty-segment, and drive-prefixed paths", () => {
    for (const path of ["/root.ts", "../root.ts", "a//b.ts", "C:\\root.ts", "\\\\server\\share.ts"]) {
      const bytes = encoder.encode(
        `diff --git a/x b/x\n--- a/x\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n`,
      );
      expect(() => parseObservedDiffHunks({
        repositoryIdentity: "repo:x",
        diffBytes: bytes,
      })).toThrow();
    }
  });

  it("rejects malformed hunk bodies instead of hashing ambiguous slices", () => {
    const bytes = encoder.encode(
      "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,1 @@\n-old\n+new\n",
    );
    expect(() => parseObservedDiffHunks({
      repositoryIdentity: "repo:x",
      diffBytes: bytes,
    })).toThrow("does not match declared ranges");
  });

  it("accepts only the exact Git no-newline marker among backslash hunk lines", () => {
    const validCrLf = encoder.encode(
      "diff --git a/x b/x\r\n"
      + "--- a/x\r\n"
      + "+++ b/x\r\n"
      + "@@ -1 +1 @@\r\n"
      + "-old\r\n"
      + "\\ No newline at end of file\r\n"
      + "+new\r\n"
      + "\\ No newline at end of file\r\n",
    );
    expect(parseObservedDiffHunks({
      repositoryIdentity: "repo:x",
      diffBytes: validCrLf,
    })).toHaveLength(1);

    for (const invalidMarker of [
      "\\ arbitrary marker",
      "\\ No newline at end of file ",
      "\\ No newline at end of file suffix",
    ]) {
      const invalid = encoder.encode(
        "diff --git a/x b/x\n"
        + "--- a/x\n"
        + "+++ b/x\n"
        + "@@ -1 +1 @@\n"
        + "-old\n"
        + `${invalidMarker}\n`
        + "+new\n",
      );
      expect(() => parseObservedDiffHunks({
        repositoryIdentity: "repo:x",
        diffBytes: invalid,
      })).toThrow("invalid observed diff no-newline marker");
    }
  });
});

describe("parseUnifiedDiffBytes compatibility projection", () => {
  it("projects the binary parse into the legacy DiffFile shape", () => {
    const bytes = readFileSync(join(FIXTURES, "l0-normative.patch"));
    expect(parseUnifiedDiffBytes(bytes)).toEqual([{
      filePath: "packages/demo.txt",
      hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2 }],
      wholeFile: false,
    }]);
  });
});
