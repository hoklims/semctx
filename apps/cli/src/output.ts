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

export function json(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function nowIso(): string {
  return new Date().toISOString();
}
