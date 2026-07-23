import { createHash, type Hash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { resolve } from "node:path";
import { SemctxError } from "@semantic-context/core";

export interface VerificationGitState {
  headCommit: string;
  workingStateHash: string;
}

interface VerificationGitSnapshot {
  state: VerificationGitState;
  untrackedPaths: string[];
}

function git(root: string, args: string[]): Uint8Array {
  const process = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (process.exitCode !== 0) {
    throw new SemctxError("GIT_ERROR", "cannot capture verification source state", {
      command: ["git", ...args],
      stderr: new TextDecoder().decode(process.stderr),
    });
  }
  return process.stdout;
}

function frame(hash: Hash, label: string, payload: string | Uint8Array): void {
  const bytes = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
  hash.update(`${label}\0${bytes.byteLength}\0`, "utf8").update(bytes);
}

function captureVerificationGitSnapshot(root: string): VerificationGitSnapshot {
  const headCommit = new TextDecoder().decode(git(root, ["rev-parse", "--verify", "HEAD"])).trim();
  if (!/^[0-9a-f]{40,64}$/.test(headCommit)) {
    throw new SemctxError("GIT_ERROR", "cannot capture verification source state: invalid HEAD", { headCommit });
  }

  const diff = git(root, ["diff", "HEAD", "--relative", "--binary", "--no-color", "--", "."]);
  const untracked = new TextDecoder().decode(
    git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", "."]),
  ).split("\0").filter((path) => path.length > 0).sort();
  const hash = createHash("sha256");
  frame(hash, "domain", "semctx:verification-working-state:v1");
  frame(hash, "tracked-diff", diff);
  for (const path of untracked) {
    const absolute = resolve(root, path);
    const stat = lstatSync(absolute);
    frame(hash, "untracked-path", path.replace(/\\/g, "/"));
    if (stat.isSymbolicLink()) {
      frame(hash, "untracked-kind", "symlink");
      frame(hash, "untracked-target", readlinkSync(absolute));
    } else if (stat.isFile()) {
      frame(hash, "untracked-kind", (stat.mode & 0o111) === 0 ? "file:100644" : "file:100755");
      frame(hash, "untracked-content", readFileSync(absolute));
    } else {
      throw new SemctxError("GIT_ERROR", "unsupported untracked verification input", { path });
    }
  }
  return {
    state: { headCommit, workingStateHash: `sha256:${hash.digest("hex")}` },
    untrackedPaths: untracked,
  };
}

/** Capture the exact commit plus tracked and non-ignored untracked working bytes verified by the guard. */
export function captureVerificationGitState(root: string): VerificationGitState {
  return captureVerificationGitSnapshot(root).state;
}

/** Capture a state that working-tree verification can authorize without omitting untracked inputs. */
export function captureRecordableVerificationGitState(root: string): VerificationGitState {
  const snapshot = captureVerificationGitSnapshot(root);
  if (snapshot.untrackedPaths.length > 0) {
    throw new SemctxError(
      "INVALID_TASK_INPUT",
      "--record refuses non-ignored untracked files because working-tree verification cannot analyze them; add, remove, or ignore them first",
      { untrackedPaths: snapshot.untrackedPaths },
    );
  }
  return snapshot.state;
}
