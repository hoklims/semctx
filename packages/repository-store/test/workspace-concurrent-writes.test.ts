import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * `writeFileNoFollow` backs every `.sem` and handoff write (HOK-666). Two real processes replace
 * the same destination at the same time and read it before and after each attempt. Every read and
 * the final file must hold one complete payload, never a mix or a truncation; at least one read
 * must see the other writer's payload, which proves the operations interleave; no temporary may
 * survive. Separate processes are required because synchronous writes inside one process cannot
 * interleave; the reads are required because a non-atomic write can still end on a complete file.
 * The read before each attempt spans the other writer's work: on Linux a read taken right after a
 * writer's own rename almost never lands between the other writer's replacements.
 */

const REPO_ROOT = process.cwd();
const RACE_TIMEOUT_MS = 60_000;
const WRITES_PER_WRITER = 150;
const INITIAL = "initial\n";
// Distinct letters and lengths make an interleaved or truncated file detectable.
const SIZE_A = 256 * 1024;
const SIZE_B = 96 * 1024;
const PAYLOAD_A = `${"A".repeat(SIZE_A)}\n`;
const PAYLOAD_B = `${"B".repeat(SIZE_B)}\n`;
// Windows refuses to replace a destination that another process holds open or is replacing, and
// reports that sharing refusal as EPERM. The refusal reaches the caller and is not corruption.
const TOLERATED_WRITE_ERRORS = process.platform === "win32" ? ["EPERM"] : [];
const dirs: string[] = [];

interface WriterResult {
  written: number;
  writeErrors: Record<string, number>;
  reads: number;
  foreignReads: number;
  readErrors: Record<string, number>;
  incompleteReadLengths: number[];
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temporaryDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** Each writer announces readiness, waits for the shared start signal, then races writes and reads. */
function writerSource(): string {
  return `
    import { existsSync, readFileSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { writeFileNoFollow } from "./packages/repository-store/src/workspace.ts";
    const [root, destination, control, name, letter, count] = process.argv.slice(1);
    const payloadA = "A".repeat(${SIZE_A}) + "\\n";
    const payloadB = "B".repeat(${SIZE_B}) + "\\n";
    const own = letter === "A" ? payloadA : payloadB;
    const other = letter === "A" ? payloadB : payloadA;
    const complete = new Set([${JSON.stringify(INITIAL)}, payloadA, payloadB]);
    const tally = (record, error) => {
      const code = error?.code ?? "UNKNOWN";
      record[code] = (record[code] ?? 0) + 1;
    };
    writeFileSync(join(control, "ready-" + name), "");
    while (!existsSync(join(control, "start"))) Bun.sleepSync(1);
    const result = { written: 0, writeErrors: {}, reads: 0, foreignReads: 0, readErrors: {}, incompleteReadLengths: [] };
    const observe = () => {
      try {
        const seen = readFileSync(destination, "utf8");
        result.reads += 1;
        if (seen === other) result.foreignReads += 1;
        if (!complete.has(seen) && result.incompleteReadLengths.length < 10) result.incompleteReadLengths.push(seen.length);
      } catch (error) {
        tally(result.readErrors, error);
      }
    };
    for (let index = 0; index < Number(count); index += 1) {
      observe();
      try {
        writeFileNoFollow(root, destination, own);
        result.written += 1;
      } catch (error) {
        tally(result.writeErrors, error);
      }
      observe();
    }
    writeFileSync(join(control, "result-" + name + ".json"), JSON.stringify(result));
  `;
}

function spawnWriter(root: string, destination: string, control: string, name: string, letter: "A" | "B") {
  return Bun.spawn(
    [process.execPath, "-e", writerSource(), root, destination, control, name, letter, String(WRITES_PER_WRITER)],
    { cwd: REPO_ROOT, stdin: "ignore", stdout: "inherit", stderr: "inherit" },
  );
}

async function waitForReady(writers: readonly Bun.Subprocess[], markers: readonly string[]): Promise<void> {
  const deadline = Date.now() + RACE_TIMEOUT_MS;
  while (!markers.every((marker) => existsSync(marker))) {
    const exited = writers.find((writer) => writer.exitCode !== null);
    if (exited !== undefined) throw new Error(`writer exited with ${exited.exitCode} before the start signal`);
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${markers.join(", ")}`);
    await Bun.sleep(5);
  }
}

function readResult(control: string, name: string): WriterResult {
  return JSON.parse(readFileSync(join(control, `result-${name}.json`), "utf8")) as WriterResult;
}

function untoleratedWriteCodes(...results: WriterResult[]): string[] {
  const codes = new Set(results.flatMap((result) => Object.keys(result.writeErrors)));
  return [...codes].filter((code) => !TOLERATED_WRITE_ERRORS.includes(code)).sort();
}

describe("writeFileNoFollow with two concurrent writer processes", () => {
  it(
    "never exposes a mixed or truncated file and leaves no temporary behind",
    async () => {
      const root = temporaryDir("semctx-concurrent-writes-");
      const control = temporaryDir("semctx-concurrent-control-");
      const destination = join(root, ".semctx", "semantic", "project", "race.sem");
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, INITIAL);

      const writers = [
        spawnWriter(root, destination, control, "a", "A"),
        spawnWriter(root, destination, control, "b", "B"),
      ];
      try {
        await waitForReady(writers, [join(control, "ready-a"), join(control, "ready-b")]);
        writeFileSync(join(control, "start"), "");
        expect(await Promise.all(writers.map((writer) => writer.exited))).toEqual([0, 0]);
      } finally {
        for (const writer of writers) if (writer.exitCode === null) writer.kill("SIGKILL");
        await Promise.all(writers.map((writer) => writer.exited));
      }

      const a = readResult(control, "a");
      const b = readResult(control, "b");
      // Enough replacements succeed for the race to exercise the destination, so a helper that
      // refused almost every write cannot hide behind the tolerated code.
      expect(a.written).toBeGreaterThanOrEqual(WRITES_PER_WRITER / 4);
      expect(b.written).toBeGreaterThanOrEqual(WRITES_PER_WRITER / 4);
      // A writer never loses its own temporary to the other one, and a read never fails.
      expect(untoleratedWriteCodes(a, b)).toEqual([]);
      expect([a.readErrors, b.readErrors]).toEqual([{}, {}]);
      expect(a.reads + b.reads).toBe(4 * WRITES_PER_WRITER);
      // The race is real: a writer observed the other writer's payload between its own attempts.
      expect(a.foreignReads + b.foreignReads).toBeGreaterThan(0);
      expect([...a.incompleteReadLengths, ...b.incompleteReadLengths]).toEqual([]);

      const final = readFileSync(destination, "utf8");
      const outcome = final === PAYLOAD_A ? "A" : final === PAYLOAD_B ? "B" : `mixed or truncated (${final.length} chars)`;
      expect(["A", "B"]).toContain(outcome);
      expect(readdirSync(dirname(destination))).toEqual([basename(destination)]);
    },
    RACE_TIMEOUT_MS + 10_000,
  );
});
