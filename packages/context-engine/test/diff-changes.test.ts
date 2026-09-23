import { describe, expect, it } from "bun:test";
import { SemctxError } from "@semantic-context/core";
import { changedFilesFromDiff, parseUnifiedDiff, parseUnifiedDiffChanges } from "@semantic-context/context-engine";

/** Blocks that carry no hunk must still be accounted for: they are changes semctx cannot read. */
describe("parseUnifiedDiffChanges (collect mode)", () => {
  it("keeps binary, mode-only, rename-only and empty-file blocks as unscoped", () => {
    const diff = [
      "diff --git a/img.png b/img.png",
      "index 1111111..2222222 100644",
      "Binary files a/img.png and b/img.png differ",
      "diff --git a/run.sh b/run.sh",
      "old mode 100644",
      "new mode 100755",
      "diff --git a/old/name.ts b/new/name.ts",
      "similarity index 100%",
      "rename from old/name.ts",
      "rename to new/name.ts",
      "diff --git a/empty.txt b/empty.txt",
      "new file mode 100644",
      "index 0000000..e69de29",
      "",
    ].join("\n");
    const parsed = parseUnifiedDiffChanges(diff);
    expect(parsed.files).toEqual([]);
    expect(parsed.unscoped).toEqual([
      { paths: ["img.png"], reason: "binary" },
      { paths: ["run.sh"], reason: "mode_only" },
      { paths: ["old/name.ts", "new/name.ts"], reason: "rename_only" },
      { paths: ["empty.txt"], reason: "empty_added" },
    ]);
    expect(changedFilesFromDiff(parsed, ["notes.md"])).toEqual([
      { path: "empty.txt", status: "added", hunks: 0 },
      { path: "img.png", status: "binary", hunks: 0 },
      { path: "new/name.ts", oldPath: "old/name.ts", status: "renamed", hunks: 0 },
      { path: "notes.md", status: "untracked", hunks: 0 },
      { path: "run.sh", status: "mode_only", hunks: 0 },
    ]);
  });

  it("keeps the old path of a renamed and edited file", () => {
    const diff = [
      "diff --git a/src/old.ts b/src/new.ts",
      "similarity index 90%",
      "rename from src/old.ts",
      "rename to src/new.ts",
      "--- a/src/old.ts",
      "+++ b/src/new.ts",
      "@@ -3 +3 @@",
      "-a",
      "+b",
      "",
    ].join("\n");
    const parsed = parseUnifiedDiffChanges(diff);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]).toMatchObject({ filePath: "src/new.ts", oldPath: "src/old.ts", status: "renamed" });
    expect(parsed.unscoped).toEqual([]);
  });

  it("marks added and deleted files", () => {
    const diff = [
      "diff --git a/src/added.ts b/src/added.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/added.ts",
      "@@ -0,0 +1 @@",
      "+x",
      "diff --git a/src/gone.ts b/src/gone.ts",
      "deleted file mode 100644",
      "--- a/src/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-x",
      "",
    ].join("\n");
    const statuses = parseUnifiedDiffChanges(diff).files.map((file) => [file.filePath, file.status]);
    expect(statuses).toEqual([
      ["src/added.ts", "added"],
      ["src/gone.ts", "deleted"],
    ]);
  });
});

/** `verify` parses in strict mode: collecting header paths for impact must not change what it accepts. */
describe("parseUnifiedDiff (strict mode)", () => {
  const oddHeader = "diff --git a/src//odd.ts b/src//odd.ts";

  it("never reads the `diff --git` header paths of a block with content headers", () => {
    const files = parseUnifiedDiff([oddHeader, "--- a/src/odd.ts", "+++ b/src/odd.ts", "@@ -1 +1 @@", "-a", "+b", ""].join("\n"));
    expect(files.map((file) => file.filePath)).toEqual(["src/odd.ts"]);
  });

  it("rejects a header-only block as a task input error, whatever its header", () => {
    let failure: unknown;
    try {
      parseUnifiedDiff([oddHeader, "Binary files a/src//odd.ts and b/src//odd.ts differ", ""].join("\n"));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(SemctxError);
    expect((failure as SemctxError).code).toBe("INVALID_TASK_INPUT");
  });

  it("collects the same header-only block as unrecognized paths instead of failing", () => {
    const parsed = parseUnifiedDiffChanges([oddHeader, "Binary files a/src//odd.ts and b/src//odd.ts differ", ""].join("\n"));
    expect(parsed.unscoped).toEqual([{ paths: [], reason: "binary" }]);
  });
});
