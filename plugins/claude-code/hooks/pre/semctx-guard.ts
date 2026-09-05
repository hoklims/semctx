import { resolve } from "node:path";
import { evaluateBashGuard, shellQuote } from "../semctx-guard.mjs";

/**
 * Oh My Pi emits `tool_call` before the tool runs, so `input` is the raw model argument object:
 * `cwd` is not yet resolved against the session directory and `env` is a structured map the host
 * passes as real child-process environment. Both are normalized here so the guard evaluates the
 * same effective command a shell would have received.
 */
type ToolCallEvent = {
  toolName?: string;
  input?: { command?: string; cwd?: string; env?: Record<string, unknown> };
};

type ToolCallCtx = { cwd?: string };

type PiApi = {
  on(
    event: "tool_call",
    handler: (
      event: ToolCallEvent,
      ctx: ToolCallCtx,
    ) => Promise<{ block: true; reason: string } | void>,
  ): void;
};

/**
 * The directory the command will actually run in. `ctx.cwd` is materialized per invocation and
 * follows session moves, so it is the correct anchor for a relative `input.cwd` — resolving against
 * `process.cwd()` would read a different repository whenever the host was launched elsewhere.
 */
function commandCwd(event: ToolCallEvent, ctx: ToolCallCtx): string {
  const base = typeof ctx?.cwd === "string" && ctx.cwd ? ctx.cwd : process.cwd();
  const requested = event?.input?.cwd;
  return typeof requested === "string" && requested ? resolve(base, requested) : base;
}

/**
 * Structured `env` entries are invisible in the command string, so a `GIT_DIR=…` retargeting sent
 * as `env` would escape the checks its inline `NAME=value` equivalent fails. Prepending the
 * assignments reuses the existing detectors instead of adding a second policy.
 */
function effectiveCommand(event: ToolCallEvent): string {
  const command = typeof event?.input?.command === "string" ? event.input.command : "";
  const env = event?.input?.env;
  if (!env || typeof env !== "object" || Array.isArray(env)) return command;
  const assignments = Object.entries(env)
    .filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    .map(([name, value]) => `${name}=${shellQuote(String(value))}`)
    .join(" ");
  if (!assignments) return command;
  return command ? `${assignments} ${command}` : assignments;
}

/** @param pi Oh My Pi extension API */
export default function semctxGuard(pi: PiApi) {
  pi.on("tool_call", async (event, ctx) => {
    try {
      const decision = evaluateBashGuard({
        toolName: event?.toolName,
        command: effectiveCommand(event),
        cwd: commandCwd(event, ctx),
        env: process.env,
      });
      if (decision.block) {
        return { block: true, reason: decision.reason };
      }
    } catch {
      // A throw here would block every bash call, so an internal guard failure allows the tool.
    }
  });
}
