import { execFileSync as execute, spawnSync as spawn, spawn as spawnAsync } from "node:child_process";

export const GIT_PROCESS_TIMEOUT_MS = 5000;
export const PROCESS_MAX_BUFFER_BYTES = 256 * 1024 * 1024;
export const GUARD_PROCESS_BUDGET_MS = 15_000;
export const CODEX_CLEANUP_BUDGET_MS = 12 * 60 * 60 * 1000;
export const VERIFICATION_STEP_BUDGET_MS = 60 * 60 * 1000;
export const BENCHMARK_SAMPLE_BUDGET_MS = 10 * 60 * 1000;

/** @returns {{timeout: number, killSignal: "SIGKILL", maxBuffer: number}} */
export function processLimits(timeoutMs = GIT_PROCESS_TIMEOUT_MS, maxBuffer = PROCESS_MAX_BUFFER_BYTES) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("PROCESS_TIMEOUT: process budget exhausted");
  }
  return { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer };
}

export function gitEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !/^(GIT(?:_|$)|GCM_)/i.test(name)));
}

function boundedOptions(options) {
  return {
    ...options,
    ...processLimits(options.timeout ?? GIT_PROCESS_TIMEOUT_MS, options.maxBuffer ?? PROCESS_MAX_BUFFER_BYTES),
  };
}

/**
 * @param {string} command
 * @param {readonly string[]} args
 * @param {import("node:child_process").SpawnSyncOptions} [options]
 * @returns {import("node:child_process").SpawnSyncReturns<Buffer | string>}
 */
export function spawnSyncWithinBudget(command, args, options = {}) {
  return spawn(command, args, boundedOptions(options));
}

/**
 * @overload
 * @param {string} command
 * @param {readonly string[]} args
 * @param {import("node:child_process").ExecFileSyncOptions & {encoding: BufferEncoding}} options
 * @returns {string}
 */
/**
 * @overload
 * @param {string} command
 * @param {readonly string[]} args
 * @param {import("node:child_process").ExecFileSyncOptions} [options]
 * @returns {Buffer | string}
 */
/**
 * @param {string} command
 * @param {readonly string[]} args
 * @param {import("node:child_process").ExecFileSyncOptions} [options]
 */
export function execFileSyncWithinBudget(command, args, options = {}) {
  return execute(command, args, boundedOptions(options));
}

export const DEFERRED_PROCESS_SUPERVISOR = String.raw`
const { spawn } = await import("node:child_process");
const [budget, ...argv] = JSON.parse(Buffer.from(process.argv[1], "base64url").toString("utf8"));
const child = spawn(argv[0], argv.slice(1), { stdio: "ignore", detached: process.platform !== "win32", windowsHide: true });
const stop = () => {
  if (process.platform === "win32") {
    const fail = () => { child.kill("SIGKILL"); process.exit(1); };
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    const limit = setTimeout(() => { killer.kill("SIGKILL"); fail(); }, 5000);
    killer.on("error", () => { clearTimeout(limit); fail(); });
    killer.on("exit", (code) => { clearTimeout(limit); if (code !== 0 && code !== 128) fail(); process.exit(1); });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    process.exit(1);
  }
};
const timer = setTimeout(stop, budget);
child.on("error", () => { clearTimeout(timer); process.exit(1); });
child.on("exit", (code) => {
  clearTimeout(timer);
  if (process.platform !== "win32") { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
  process.exit(code ?? 1);
});
`;

const TREE_TERMINATION_WAIT_MS = 5000;

const ROOT_EXIT_POLL_MS = 25;
const ROOT_EXIT_WAIT_MS = 1000;

function processIsGone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}

// Windows stops a tree with one `taskkill`. Resolves to {} when the tree is gone, to {warning} when
// taskkill reported a non-zero status but the direct child is verifiably gone, and to {failure}
// when the direct child could not be stopped.
function taskkillTree(pid) {
  return new Promise((resolveKill) => {
    let done = false;
    const finish = (reason, warning) => {
      if (done) return;
      done = true;
      clearTimeout(limit);
      if (reason === undefined) {
        resolveKill(warning === undefined ? {} : { warning });
        return;
      }
      // taskkill did not establish termination: still stop the direct child.
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      resolveKill({ failure: `PROCESS_TERMINATION_FAILED: ${reason}` });
    };
    const killer = spawnAsync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    const limit = setTimeout(() => {
      killer.kill("SIGKILL");
      finish(`taskkill exceeded its ${TREE_TERMINATION_WAIT_MS} ms termination budget`);
    }, TREE_TERMINATION_WAIT_MS);
    killer.on("error", (error) => finish(`taskkill could not run: ${error.message}`));
    killer.on("exit", (code) => {
      // 128 is "process not found": the child had already exited, so there is nothing left to stop.
      if (code === 0 || code === 128) {
        finish(undefined);
        return;
      }
      // Any other status (255 for a descendant that exited between enumeration and termination)
      // is a failure only if the direct child is still alive once taskkill has returned.
      const deadline = performance.now() + ROOT_EXIT_WAIT_MS;
      const poll = () => {
        if (done) return;
        if (processIsGone(pid)) {
          finish(undefined, `taskkill exited with status ${code}; the direct child is gone`);
        } else if (performance.now() >= deadline) {
          finish(`taskkill exited with status ${code}`);
        } else {
          setTimeout(poll, ROOT_EXIT_POLL_MS);
        }
      };
      poll();
    });
  });
}

// Resolves to {failure} when the direct child could not be stopped and to {warning} when only
// descendants outside its process group may have survived: the deadline outcome stays typed.
function killPosixTree(pid) {
  if (pid === undefined) return {};
  let failure;
  let warning;
  {
    // Nested owned process groups are found through a `ps` inventory taken before the direct group
    // is stopped. It is best effort: whatever goes wrong with it, the direct group is still stopped.
    try {
      const options = {
        encoding: "utf8", timeout: 500, maxBuffer: 4 * 1024 * 1024,
      };
      let inventory;
      try {
        inventory = execFileSyncWithinBudget("ps", ["-A", "-o", "pid=,ppid="], options);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        inventory = execFileSyncWithinBudget("/bin/ps", ["-A", "-o", "pid=,ppid="], options);
      }
      const children = new Map();
      for (const line of inventory.trim().split("\n")) {
        const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
        if (match === null) throw new Error("invalid process inventory");
        const child = Number(match[1]);
        const parent = Number(match[2]);
        if (!Number.isSafeInteger(child) || child <= 0 || !Number.isSafeInteger(parent) || parent < 0 || child === parent) {
          throw new Error("invalid process inventory");
        }
        children.set(parent, [...(children.get(parent) ?? []), child]);
      }
      const descendants = [pid];
      const seen = new Set(descendants);
      for (let index = 0; index < descendants.length; index++) {
        for (const child of children.get(descendants[index]) ?? []) {
          if (seen.has(child)) continue;
          seen.add(child);
          descendants.push(child);
        }
      }
      for (const child of descendants.slice(1).reverse()) {
        try { process.kill(-child, "SIGKILL"); } catch {
          try { process.kill(child, "SIGKILL"); } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
        }
      }
    } catch (error) {
      warning = `nested process groups may have survived: ${error.message}`;
    }
  }
  try {
    try { process.kill(-pid, "SIGKILL"); } catch {
      process.kill(pid, "SIGKILL");
    }
  } catch (error) {
    if (error.code !== "ESRCH") failure = `PROCESS_TERMINATION_FAILED: ${error.message}`;
  }
  return { failure, warning };
}

async function killTree(pid) {
  if (pid === undefined) return {};
  return process.platform === "win32" ? await taskkillTree(pid) : killPosixTree(pid);
}

export { killTree as terminateProcessTree };

// Detached workers do not receive the supervisor's foreground signals. Stop every owned tree
// before restoring the original signal's default behavior, including concurrent budgeted calls.
const activeProcessIds = new Set();
let cancelling = false;
const onInterrupt = () => cancelProcesses("SIGINT");
const onTerminate = () => cancelProcesses("SIGTERM");
function removeSignalHandlers() {
  process.removeListener("SIGINT", onInterrupt);
  process.removeListener("SIGTERM", onTerminate);
}
function cancelProcesses(signal) {
  if (cancelling) return;
  cancelling = true;
  const hasHostHandler = process.listeners(signal).some((listener) => listener !== onInterrupt && listener !== onTerminate);
  // This must stay synchronous: a host listener may call process.exit during the same event.
  for (const pid of activeProcessIds) killPosixTree(pid);
  removeSignalHandlers();
  cancelling = false;
  if (!hasHostHandler) process.kill(process.pid, signal);
}
function ownProcess(pid) {
  if (process.platform === "win32" || pid === undefined) return () => {};
  activeProcessIds.add(pid);
  // A host signal handler can start a replacement before killed children have been reaped.
  // Cancellation removed our handlers, even while those old PIDs still occupy the set.
  if (!process.listeners("SIGINT").includes(onInterrupt)) {
    process.prependListener("SIGINT", onInterrupt);
  }
  if (!process.listeners("SIGTERM").includes(onTerminate)) {
    process.prependListener("SIGTERM", onTerminate);
  }
  return () => {
    activeProcessIds.delete(pid);
    if (activeProcessIds.size === 0 && !cancelling) removeSignalHandlers();
  };
}

/**
 * @param {readonly string[]} argv
 * @param {{cwd: string, budgetMs: number, env?: NodeJS.ProcessEnv, stdin?: "inherit" | "ignore", stdout?: number, maxBytes?: number, inheritOutput?: boolean, onMessage?: (message: unknown) => void}} options
 * @returns {Promise<{kind: "exited", exitCode: number, stdout: string, stderr: string, elapsedMs: number} | {kind: "timeout", elapsedMs: number, terminationWarning?: string}>}
 */
export async function runProcessWithinBudget(argv, options) {
  const started = performance.now();
  const [command, ...args] = argv;
  if (command === undefined) throw new Error("bounded process requires a command");
  const child = spawnAsync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: [options.stdin ?? "ignore", options.stdout ?? (options.inheritOutput ? "inherit" : "pipe"), options.inheritOutput ? "inherit" : "pipe", ...(options.onMessage ? ["ipc"] : [])],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  if (options.onMessage) child.on("message", options.onMessage);
  const releaseProcess = ownProcess(child.pid);
  const elapsed = () => Math.round(performance.now() - started);

  return await new Promise((resolveOutcome) => {
    let settled = false;
    let overflowed = false;
    let expired = false;
    let termination;
    let bytes = 0;
    const stdout = [];
    const stderr = [];
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // An incomplete tree kill can leave descendants holding captured pipes open. Release our
      // read ends once the bounded result is final, so a one-shot caller can exit naturally.
      if (termination !== undefined) {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
      releaseProcess();
      resolveOutcome(outcome);
    };
    // Output overflow and the deadline both stop the tree; whichever comes first does it once.
    const terminate = () => {
      if (termination === undefined) termination = killTree(child.pid);
      return termination;
    };
    const collect = (sink) => (chunk) => {
      bytes += chunk.byteLength;
      if (bytes > (options.maxBytes ?? 16 * 1024 * 1024)) {
        if (!overflowed) {
          overflowed = true;
          void terminate().then(({ failure }) => {
            settle({ kind: "exited", exitCode: 1, stdout: "", stderr: failure ?? "bounded child output exceeded its byte limit", elapsedMs: elapsed() });
          });
        }
        return;
      }
      sink.push(chunk);
    };
    child.stdout?.on("data", collect(stdout));
    child.stderr?.on("data", collect(stderr));
    const timer = setTimeout(async () => {
      if (overflowed) return;
      expired = true;
      const { failure, warning } = await terminate();
      settle(failure === undefined
        ? { kind: "timeout", elapsedMs: elapsed(), ...(warning === undefined ? {} : { terminationWarning: warning }) }
        : { kind: "exited", exitCode: 1, stdout: "", stderr: failure, elapsedMs: elapsed() });
    }, options.budgetMs);
    child.on("error", (error) => {
      settle({ kind: "exited", exitCode: 1, stdout: "", stderr: String(error), elapsedMs: elapsed() });
    });
    child.on("close", async (code) => {
      // The child's exit is the consequence of the kill the deadline is still awaiting, not a result.
      if (expired || overflowed) return;
      settle({
        kind: "exited",
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        elapsedMs: elapsed(),
      });
    });
  });
}
