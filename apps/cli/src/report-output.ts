/**
 * Shared writers for the explicit `--output`/export path of local reports (verify report,
 * feedback aggregate, support diagnostics). Default preview writes nothing; these only run when
 * the user opts in. Neither writer follows a link: every entry from the destination up to the
 * filesystem root is checked with `lstat` first, so a dangling link is refused rather than
 * followed. That check is the defence, not `O_CREAT | O_EXCL` alone: POSIX fails an exclusive
 * open on a link, but Windows `CREATE_NEW` follows a dangling one and creates its target.
 */
import { randomBytes } from "node:crypto";
import { closeSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { SemctxError } from "@semantic-context/core";
import { isLinkedEntry } from "@semantic-context/repository-store";

function assertNoLinkedAncestor(path: string): void {
  for (let current = resolve(path);; current = dirname(current)) {
    if (isLinkedEntry(current)) throw new SemctxError("IO_ERROR", `refusing to write through an existing symlink: ${current}`, { path });
    if (current === dirname(current)) break;
  }
}

/** Create a new report file; refuses an existing destination instead of overwriting it. */
export function writeNewLocalReportFile(path: string, content: string): void {
  assertNoLinkedAncestor(path);
  try {
    writeFileSync(path, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new SemctxError("IO_ERROR", `refusing to overwrite an existing file: ${path}`, { path });
    }
    throw error;
  }
}

/**
 * Replace a report file atomically (a re-run overwrites the previous report). The temporary name
 * is unguessable, checked with `lstat` and created exclusively, then renamed into place, so a
 * `<report>.tmp` link shipped by the analysed checkout is never followed. The GitHub Action writes
 * its report inside that checkout, which is why the fixed `.tmp` name of the previous writer was
 * a way for a pull request to overwrite any file the runner could reach.
 */
export function replaceLocalReportFile(path: string, content: string): void {
  assertNoLinkedAncestor(path);
  const temporary = `${resolve(path)}.${randomBytes(9).toString("hex")}.tmp`;
  if (isLinkedEntry(temporary)) throw new SemctxError("IO_ERROR", `refusing to write through an existing symlink: ${temporary}`, { path });
  const descriptor = openSync(temporary, "wx", 0o644);
  try {
    writeFileSync(descriptor, content, "utf8");
  } catch (error) {
    closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw error;
  }
  closeSync(descriptor);
  try {
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
