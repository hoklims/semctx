/** Minimal, readable console output. Colour only when stdout is a TTY. */

const isTty = process.stdout.isTTY === true && process.env["NO_COLOR"] === undefined;

const CODES = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
} as const;

type ColorName = keyof typeof CODES;

function paint(text: string, color: ColorName): string {
  if (!isTty) return text;
  return `${CODES[color]}${text}${CODES.reset}`;
}

export const c = {
  dim: (t: string) => paint(t, "dim"),
  bold: (t: string) => paint(t, "bold"),
  red: (t: string) => paint(t, "red"),
  green: (t: string) => paint(t, "green"),
  yellow: (t: string) => paint(t, "yellow"),
  blue: (t: string) => paint(t, "blue"),
  cyan: (t: string) => paint(t, "cyan"),
};

export function info(message: string): void {
  process.stdout.write(`${message}\n`);
}

export function heading(message: string): void {
  process.stdout.write(`\n${c.bold(message)}\n`);
}

export function success(message: string): void {
  process.stdout.write(`${c.green("OK")} ${message}\n`);
}

export function warn(message: string): void {
  process.stderr.write(`${c.yellow("WARN")} ${message}\n`);
}

export function fail(message: string): void {
  process.stderr.write(`${c.red("ERROR")} ${message}\n`);
}

/**
 * `Name: message` for a failure that reaches the CLI's top level, read from the error rather than
 * from its `stack`: through Bun 1.4.2, a garbage collection that materializes an unread stack drops
 * that header (oven-sh/bun#34398), which printed a bare `Error` for an error thrown across an
 * `await`. `SEMCTX_DEBUG=1` appends the stack frames.
 */
export function describeError(err: unknown, env: Record<string, string | undefined> = process.env): string {
  if (!(err instanceof Error)) return String(err);
  const summary = err.message === "" ? err.name : `${err.name}: ${err.message}`;
  if (env["SEMCTX_DEBUG"] !== "1") return summary;
  const stackLines = (err.stack ?? "").split("\n");
  const firstFrame = stackLines.findIndex((line) => line.startsWith("    at "));
  return firstFrame === -1 ? summary : [summary, ...stackLines.slice(firstFrame)].join("\n");
}

export function json(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function nowIso(): string {
  return new Date().toISOString();
}
