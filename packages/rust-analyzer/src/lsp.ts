import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { z } from "zod";
import { terminateProcessTree } from "../../../plugins/shared/hooks/process-budget.mjs";

const MessageSchema = z.object({
  jsonrpc: z.literal("2.0"), id: z.union([z.number().int(), z.string()]).optional(),
  method: z.string().optional(), params: z.unknown().optional(), result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).passthrough().optional(),
}).passthrough();

export class RustLspClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private readonly readyWaiters: { resolve(): void; reject(error: Error): void }[] = [];
  private buffer: Buffer = Buffer.alloc(0);
  private bytes = 0;
  private sequence = 0;
  private failure: Error | undefined;
  private ready = false;
  private closing = false;

  constructor(argv: readonly string[], options: { cwd: string; budgetMs: number; env?: NodeJS.ProcessEnv }) {
    if (argv[0] === undefined || !Number.isSafeInteger(options.budgetMs) || options.budgetMs < 1) throw new Error("RUST_LSP_CONFIGURATION_INVALID");
    this.child = spawn(argv[0], argv.slice(1), { cwd: options.cwd, env: options.env, stdio: "pipe", detached: process.platform !== "win32", windowsHide: true });
    this.timer = setTimeout(() => this.fail(new Error("RUST_LSP_TIMEOUT")), options.budgetMs);
    this.child.on("error", (error) => this.fail(new Error(`RUST_LSP_START: ${error.message}`)));
    this.child.on("close", (code) => {
      if (!this.closing) this.fail(new Error(`RUST_LSP_EXIT:${code}`));
    });
    this.child.stdin.on("error", (error) => this.fail(new Error(`RUST_LSP_WRITE:${error.message}`)));
    this.child.stderr.on("data", (chunk: Buffer) => this.account(chunk.length));
    this.child.stdout.on("data", (chunk: Buffer) => {
      try { this.receive(chunk); }
      catch (error) { this.fail(new Error(`RUST_LSP_PROTOCOL: ${error instanceof Error ? error.message : "invalid response"}`)); }
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (this.closing) return Promise.reject(new Error("RUST_LSP_CLOSED"));
    if (this.pending.size !== 0) return Promise.reject(new Error("RUST_LSP_REQUEST_CONCURRENCY"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (this.failure !== undefined) throw this.failure;
    this.send({ jsonrpc: "2.0", method, params });
  }

  waitUntilReady(): Promise<void> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (this.ready) return Promise.resolve();
    return new Promise((resolve, reject) => this.readyWaiters.push({ resolve, reject }));
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    clearTimeout(this.timer);
    this.fail(new Error("RUST_LSP_CLOSED"));
    const outcome = z.object({ failure: z.string().optional(), warning: z.string().optional() }).parse(await terminateProcessTree(this.child.pid));
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
    if (outcome.failure !== undefined || outcome.warning !== undefined) {
      throw new Error(`RUST_LSP_TERMINATION_FAILED: ${outcome.failure ?? outcome.warning}`);
    }
  }

  private account(length: number): void {
    this.bytes += length;
    if (this.bytes > 32 * 1024 * 1024) this.fail(new Error("RUST_LSP_OUTPUT_LIMIT"));
  }

  private send(value: unknown): void {
    const body = Buffer.from(JSON.stringify(value));
    this.child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
  }

  private fail(error: Error): void {
    this.failure ??= error;
    for (const request of this.pending.values()) request.reject(this.failure);
    this.pending.clear();
    for (const waiter of this.readyWaiters.splice(0)) waiter.reject(this.failure);
  }

  private receive(chunk: Buffer): void {
    this.account(chunk.length);
    if (this.failure !== undefined) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const boundary = this.buffer.indexOf("\r\n\r\n");
      if (boundary < 0) {
        if (this.buffer.length > 8192) throw new Error("header limit");
        return;
      }
      if (boundary > 8192) throw new Error("header limit");
      const lengths = this.buffer.subarray(0, boundary).toString("ascii").split("\r\n")
        .filter((line) => /^Content-Length:/i.test(line));
      const raw = lengths.length === 1 ? /^Content-Length:\s*(\d+)\s*$/i.exec(lengths[0]!)?.[1] : undefined;
      const length = Number(raw);
      if (raw === undefined || !Number.isSafeInteger(length) || length < 1 || length > 8 * 1024 * 1024) throw new Error("invalid content length");
      if (this.buffer.length < boundary + 4 + length) return;
      const body = this.buffer.subarray(boundary + 4, boundary + 4 + length);
      this.buffer = this.buffer.subarray(boundary + 4 + length);
      const message = MessageSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)));
      if (message.method !== undefined) {
        if (message.id !== undefined) {
          const supported = ["window/workDoneProgress/create", "client/registerCapability"].includes(message.method);
          this.send(supported ? { jsonrpc: "2.0", id: message.id, result: null }
            : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unsupported client request" } });
        } else if (message.method === "experimental/serverStatus") {
          const status = z.object({ quiescent: z.boolean(), health: z.enum(["ok", "warning", "error"]) }).parse(message.params);
          if (status.health !== "ok") this.fail(new Error(`RUST_LSP_READINESS:${status.health}`));
          this.ready = status.quiescent && status.health === "ok";
          if (this.ready) for (const waiter of this.readyWaiters.splice(0)) waiter.resolve();
        }
        continue;
      }
      if (typeof message.id !== "number" || !this.pending.has(message.id)) throw new Error("unknown response id");
      const pending = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      if (message.error !== undefined) pending.reject(new Error(`RUST_LSP_REQUEST:${message.error.code}:${message.error.message}`));
      else if (Object.hasOwn(message, "result")) pending.resolve(message.result);
      else pending.reject(new Error("RUST_LSP_PROTOCOL: missing result"));
    }
  }
}
