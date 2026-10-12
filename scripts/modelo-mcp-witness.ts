import { DEFAULT_MCP_LIMITS } from "./prove-stable-delivery";

export type McpWitnessLimits = Pick<typeof DEFAULT_MCP_LIMITS, "exchangeDeadlineMs" | "stdoutMaxBytes" | "stderrMaxBytes" | "terminateGraceMs" | "teardownMs">;
export const MODELO_MCP_LIMITS: McpWitnessLimits = { ...DEFAULT_MCP_LIMITS, exchangeDeadlineMs: 30_000 };
export function mcpWitnessWorstCaseMs(limits: McpWitnessLimits = MODELO_MCP_LIMITS): number {
  return limits.exchangeDeadlineMs + limits.terminateGraceMs + limits.teardownMs * 5;
}
type FailureCode = "MCP_EXCHANGE_DEADLINE" | "MCP_STDOUT_LIMIT" | "MCP_STDOUT_CLOSED" | "MCP_PROTOCOL_INVALID" | "MCP_TRANSPORT_FAILED" | "MCP_TEARDOWN_INCOMPLETE";
type Failure = { code: FailureCode; message: string };
export type McpWitnessOutcome = {
  command: string[]; pid: number; exitCode: number | null; signalCode: string | null;
  initialize: Record<string, unknown> | null; result: Record<string, unknown> | null;
  failure: Failure | null; stderr: string; stdoutBytes: number; stderrBytes: number;
  teardown: { forced: boolean; childExited: boolean; stdoutClosed: boolean; stderrClosed: boolean; stdoutCancelled: boolean; stderrCancelled: boolean };
};
class ProtocolFailure extends Error {
  constructor(readonly code: FailureCode, message: string) { super(message); }
}
const TIMEOUT = Symbol("timeout");
async function within<T>(task: Promise<T>, milliseconds: number): Promise<T | typeof TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([task, new Promise<typeof TIMEOUT>(resolve => { timer = setTimeout(() => resolve(TIMEOUT), milliseconds); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Bounded verification exchange; only the direct spawned child's exit is claimed. */
export async function verifyMcpWitness(input: { bundle: string; cwd: string; repositoryRoot: string; env: Record<string, string | undefined>; limits?: McpWitnessLimits }): Promise<McpWitnessOutcome> {
  const limits = input.limits ?? MODELO_MCP_LIMITS;
  const command = [process.execPath, input.bundle];
  const child = Bun.spawn(command, { cwd: input.cwd, env: input.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const stdoutReader = child.stdout.getReader();
  const stderrReader = child.stderr.getReader();
  const outcome: McpWitnessOutcome = {
    command, pid: child.pid, exitCode: null, signalCode: null, initialize: null, result: null, failure: null,
    stderr: "", stdoutBytes: 0, stderrBytes: 0,
    teardown: { forced: false, childExited: false, stdoutClosed: false, stderrClosed: false, stdoutCancelled: false, stderrCancelled: false },
  };
  let terminal: ProtocolFailure | null = null;
  const waiting: { current: { id: number; resolve: (value: Record<string, unknown>) => void; reject: (cause: ProtocolFailure) => void } | null } = { current: null };
  function fail(cause: ProtocolFailure): void { terminal ??= cause; waiting.current?.reject(cause); waiting.current = null; }
  const stderrDrain = (async () => {
    const decoder = new TextDecoder();
    while (true) {
      const next = await stderrReader.read(); if (next.done) { outcome.teardown.stderrClosed = true; break; }
      const retained = next.value.subarray(0, Math.max(0, limits.stderrMaxBytes - outcome.stderrBytes));
      outcome.stderrBytes += retained.length; outcome.stderr += decoder.decode(retained, { stream: true });
    }
    outcome.stderr += decoder.decode();
  })().catch((cause: unknown) => { fail(new ProtocolFailure("MCP_TRANSPORT_FAILED", String(cause))); });
  const stdoutDrain = (async () => {
    const decoder = new TextDecoder(); let pending = "";
    while (true) {
      const next = await stdoutReader.read();
      if (next.done) { outcome.teardown.stdoutClosed = true; fail(new ProtocolFailure("MCP_STDOUT_CLOSED", "MCP process ended before responding")); break; }
      outcome.stdoutBytes += next.value.length;
      if (outcome.stdoutBytes > limits.stdoutMaxBytes) { fail(new ProtocolFailure("MCP_STDOUT_LIMIT", `MCP stdout exceeded ${limits.stdoutMaxBytes} bytes`)); break; }
      pending += decoder.decode(next.value, { stream: true });
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1); if (!line.trim()) continue;
        let response: unknown;
        try { response = JSON.parse(line); } catch { fail(new ProtocolFailure("MCP_PROTOCOL_INVALID", "MCP stdout contained non-JSON protocol data")); return; }
        if (!record(response) || response.jsonrpc !== "2.0") { fail(new ProtocolFailure("MCP_PROTOCOL_INVALID", "MCP response lacks the JSON-RPC envelope")); return; }
        if (waiting.current === null || response.id !== waiting.current.id) continue;
        if (response.error !== undefined || !record(response.result)) { fail(new ProtocolFailure("MCP_PROTOCOL_INVALID", "MCP request returned an error or malformed result")); return; }
        const current = waiting.current; waiting.current = null; current?.resolve(response.result);
      }
    }
  })().catch((cause: unknown) => { fail(new ProtocolFailure("MCP_TRANSPORT_FAILED", String(cause))); });
  async function send(message: unknown): Promise<void> { await child.stdin.write(`${JSON.stringify(message)}\n`); await child.stdin.flush(); }
  function request(id: number, method: string, params: unknown): Promise<Record<string, unknown>> {
    if (terminal !== null) return Promise.reject(terminal);
    return new Promise((resolve, reject) => {
      waiting.current = { id, resolve, reject };
      void send({ jsonrpc: "2.0", id, method, params }).catch((cause: unknown) => fail(new ProtocolFailure("MCP_TRANSPORT_FAILED", String(cause))));
    });
  }
  const exchange = (async () => {
    outcome.initialize = await request(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "public-consumer-qualification", version: "1" } });
    await send({ jsonrpc: "2.0", method: "notifications/initialized" });
    outcome.result = await request(2, "tools/call", { name: "semctx_verify_change", arguments: { repositoryRoot: input.repositoryRoot } });
  })().catch((cause: unknown) => {
    const failure = cause instanceof ProtocolFailure ? cause : new ProtocolFailure("MCP_TRANSPORT_FAILED", String(cause));
    outcome.failure = { code: failure.code, message: failure.message };
  });
  try {
    if (await within(exchange, limits.exchangeDeadlineMs) === TIMEOUT) {
      const failure = new ProtocolFailure("MCP_EXCHANGE_DEADLINE", `MCP exchange exceeded ${limits.exchangeDeadlineMs}ms`);
      fail(failure); outcome.failure = { code: failure.code, message: failure.message };
    }
  } finally {
    fail(new ProtocolFailure("MCP_TRANSPORT_FAILED", "MCP exchange finished"));
    try { void Promise.resolve(child.stdin.end()).catch(() => undefined); } catch { /* closed child input */ }
    try { child.kill(); } catch { /* already exited */ }
    if (await within(child.exited, limits.terminateGraceMs) === TIMEOUT) {
      outcome.teardown.forced = true;
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
      outcome.teardown.childExited = await within(child.exited, limits.teardownMs) !== TIMEOUT;
    } else outcome.teardown.childExited = true;
    await within(stdoutDrain, limits.teardownMs);
    if (!outcome.teardown.stdoutClosed) outcome.teardown.stdoutCancelled = await within(stdoutReader.cancel().catch(() => undefined), limits.teardownMs) !== TIMEOUT;
    await within(stderrDrain, limits.teardownMs);
    if (!outcome.teardown.stderrClosed) outcome.teardown.stderrCancelled = await within(stderrReader.cancel().catch(() => undefined), limits.teardownMs) !== TIMEOUT;
    outcome.exitCode = child.exitCode; outcome.signalCode = child.signalCode;
    if (!outcome.teardown.childExited
      || (!outcome.teardown.stdoutClosed && !outcome.teardown.stdoutCancelled)
      || (!outcome.teardown.stderrClosed && !outcome.teardown.stderrCancelled)) {
      outcome.failure = { code: "MCP_TEARDOWN_INCOMPLETE", message: "MCP direct child exit or owned stream completion was not observed inside teardown bound" };
    }
  }
  return outcome;
}
