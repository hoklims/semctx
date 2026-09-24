import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeError } from "../src/output";

const CLI = join(import.meta.dir, "..", "src", "index.ts");
const SPAWN_TIMEOUT_MS = 60_000;
const UNSUPPORTED_OPTION =
  "unsupported option(s) for semctx control verify-authorization <request.json>: --bogus";
const BOGUS_OPTION_ARGV = ["control", "verify-authorization", "request.json", "--bogus"];

/**
 * Stack headers a child process can be given, besides its runtime's own (`native`): the name alone,
 * as a Bun collection leaves an unread stack (oven-sh/bun#34398), or one that contradicts the error.
 * A preload shapes only the stacks formatted on access; a stack a collection materializes first
 * keeps the runtime's own format, so no assertion depends on which of the two a report read.
 */
const STACK_HEADERS = {
  missing: "error.name",
  stale: 'error.name + ": stale header"',
};
type StackState = "native" | keyof typeof STACK_HEADERS;
const STACK_STATES: readonly StackState[] = ["native", "missing", "stale"];

/** A preload that records its state in `sentinel`, then formats every stack with `header`. */
function stackPreload(state: string, header: string, sentinel: string): string {
  return [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(sentinel)}, ${JSON.stringify(state)});`,
    `Error.prepareStackTrace = (error, frames) => [${header}, ...frames.map((frame) => "    at " + frame)].join("\\n");`,
    "",
  ].join("\n");
}

/**
 * Runs this Bun with `args` in a fresh temporary directory that holds only the preloads and
 * `probe.js`, so no `.env` applies, with SEMCTX_DEBUG removed from the inherited environment unless
 * `debug` sets it. `code` is null when a signal ended the child; `preload` is the preload that ran.
 */
function runBun(
  args: readonly string[],
  options: { debug?: string; stack?: StackState } = {},
): { code: number | null; out: string; err: string; preload: string } {
  const directory = mkdtempSync(join(tmpdir(), "semctx-error-report-"));
  try {
    const sentinel = join(directory, "preloaded");
    for (const [state, header] of Object.entries(STACK_HEADERS)) {
      writeFileSync(join(directory, `${state}.js`), stackPreload(state, header, sentinel), "utf8");
    }
    writeFileSync(join(directory, "probe.js"), 'console.log(new Error("the message").stack.split("\\n")[0]);\n', "utf8");
    const env: Record<string, string | undefined> = { ...process.env };
    delete env["SEMCTX_DEBUG"];
    if (options.debug !== undefined) env["SEMCTX_DEBUG"] = options.debug;
    const stack = options.stack ?? "native";
    const preloadArgs = stack === "native" ? [] : [`--preload=${join(directory, `${stack}.js`)}`];
    const child = Bun.spawnSync([process.execPath, ...preloadArgs, ...args], {
      cwd: directory,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      code: child.exitCode,
      out: new TextDecoder().decode(child.stdout),
      err: new TextDecoder().decode(child.stderr),
      preload: existsSync(sentinel) ? readFileSync(sentinel, "utf8") : "native",
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * An error whose stack nothing has read yet, then a full collection. Through Bun 1.4.2 the
 * collection materializes that stack as `Error\n    at ...`, without the message
 * (oven-sh/bun#34398); later runtimes keep the header.
 */
async function errorCollectedBeforeStackRead(message: string): Promise<unknown> {
  const reject = async (): Promise<never> => {
    throw new Error(message);
  };
  let caught: unknown;
  try {
    await reject();
  } catch (err) {
    caught = err;
  }
  Bun.gc(true);
  return caught;
}

function withStack(err: Error, stack: string | undefined): Error {
  Object.defineProperty(err, "stack", { value: stack });
  return err;
}

const FRAMES = "    at reject (reject.ts:1:1)\n    at caller (caller.ts:2:2)";

describe("top-level error report", () => {
  it("takes the message from the error even after a collection materialized its stack", async () => {
    const err = await errorCollectedBeforeStackRead(UNSUPPORTED_OPTION);
    if (Bun.semver.satisfies(Bun.version, "<=1.4.2")) {
      // The runtime state under test: the collection has already dropped the header.
      expect((err as Error).stack?.split("\n")[0]).toBe("Error");
    }
    expect(describeError(err, {})).toBe(`Error: ${UNSUPPORTED_OPTION}`);
    const debug = describeError(err, { SEMCTX_DEBUG: "1" }).split("\n");
    expect(debug[0]).toBe(`Error: ${UNSUPPORTED_OPTION}`);
    expect(debug[1]).toStartWith("    at ");
  });

  it("does not take the header from its stack, whether that lacks or contradicts the message", () => {
    for (const header of ["Error", "Error: stale header"]) {
      const err = withStack(new Error("the message"), `${header}\n${FRAMES}`);
      expect(describeError(err, {})).toBe("Error: the message");
      expect(describeError(err, { SEMCTX_DEBUG: "1" })).toBe(`Error: the message\n${FRAMES}`);
    }
  });

  it("names the error type, keeps a multi-line message whole, and handles empty and non-Error values", () => {
    expect(describeError(new TypeError("not a function"), {})).toBe("TypeError: not a function");
    class RenamedError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "InputRefused";
      }
    }
    expect(describeError(new RenamedError("no"), {})).toBe("InputRefused: no");
    expect(describeError(new Error("first line\nsecond line"), {})).toBe("Error: first line\nsecond line");
    expect(describeError(new Error(), {})).toBe("Error");
    expect(describeError("plain string", {})).toBe("plain string");
  });

  it("appends the stack frames only when SEMCTX_DEBUG is exactly 1", () => {
    const err = withStack(new Error("the message"), `Error: the message\n${FRAMES}`);
    for (const value of [undefined, "", "0", "true", "01", " 1"]) {
      expect(describeError(err, { SEMCTX_DEBUG: value })).toBe("Error: the message");
    }
    expect(describeError(err, { SEMCTX_DEBUG: "1" })).toBe(`Error: the message\n${FRAMES}`);
  });

  it("adds only the stack's frame lines to the debug report, never its header lines", () => {
    const multiLine = withStack(new Error("first line\nsecond line"), `Error: first line\nsecond line\n${FRAMES}`);
    expect(describeError(multiLine, { SEMCTX_DEBUG: "1" })).toBe(`Error: first line\nsecond line\n${FRAMES}`);
    const env = { SEMCTX_DEBUG: "1" };
    expect(describeError(withStack(new Error("the message"), "Error: the message"), env)).toBe("Error: the message");
    expect(describeError(withStack(new Error("the message"), undefined), env)).toBe("Error: the message");
  });

  it("preloads each stack header into a `bun run` process", () => {
    const expected: Record<StackState, string> = {
      native: "Error: the message\n",
      missing: "Error\n",
      stale: "Error: stale header\n",
    };
    for (const stack of STACK_STATES) {
      expect({ stack, ...runBun(["run", "./probe.js"], { stack }) }).toEqual({
        stack,
        code: 0,
        out: expected[stack],
        err: "",
        preload: stack,
      });
    }
  }, SPAWN_TIMEOUT_MS);

  it("prints only `ERROR Name: message` for a thrown Error, exit 1, whatever header its stack carries", () => {
    for (const stack of STACK_STATES) {
      expect({ stack, ...runBun(["run", CLI, ...BOGUS_OPTION_ARGV], { stack }) }).toEqual({
        stack,
        code: 1,
        out: "",
        err: `ERROR Error: ${UNSUPPORTED_OPTION}\n`,
        preload: stack,
      });
    }
  }, SPAWN_TIMEOUT_MS);

  it("follows the same line with the stack's frame lines under SEMCTX_DEBUG=1, exit 1", () => {
    for (const stack of STACK_STATES) {
      const result = runBun(["run", CLI, ...BOGUS_OPTION_ARGV], { debug: "1", stack });
      const [header, ...frames] = result.err.trimEnd().split("\n");
      expect({ stack, code: result.code, out: result.out, header, preload: result.preload }).toEqual({
        stack,
        code: 1,
        out: "",
        header: `ERROR Error: ${UNSUPPORTED_OPTION}`,
        preload: stack,
      });
      expect(frames.every((line) => line.startsWith("    at "))).toBe(true);
      // Every frame of the call chain, not just the first.
      expect({ stack, calls: frames.slice(0, 4).map((line) => /^ {4}at (\S+) \(/.exec(line)?.[1]) }).toEqual({
        stack,
        calls: ["runControlVerifyAuthorization", "runControl", "dispatch", "main"],
      });
    }
  }, SPAWN_TIMEOUT_MS);

  it("keeps a multi-line message whole in the real report", () => {
    // A flag name spanning two lines gives the same thrown Error a two-line message.
    const result = runBun(["run", CLI, "control", "verify-authorization", "request.json", "--bo\ngus"]);
    expect(result).toEqual({
      code: 1,
      out: "",
      err: "ERROR Error: unsupported option(s) for semctx control verify-authorization <request.json>: --bo\ngus\n",
      preload: "native",
    });
  }, SPAWN_TIMEOUT_MS);
});
