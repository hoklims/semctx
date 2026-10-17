import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RustNavigationConfig } from "@semantic-context/core";
import { spawnSyncWithinBudget } from "../../../plugins/shared/hooks/process-budget.mjs";
import { RustExtractionSchema, type RustExtraction, type RustSource } from "./model";

export function extractRustSync(files: readonly RustSource[], options: { budgetMs?: number; navigation?: RustNavigationConfig; metadata?: readonly RustSource[] } = {}): RustExtraction {
  const budgetMs = options.budgetMs ?? options.navigation?.budgetMs ?? 60_000;
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 600_000) throw new Error("RUST_BUDGET_INVALID");
  const bundled = join(import.meta.dir, "semctx-rust-worker.js");
  const worker = existsSync(bundled) ? bundled : join(import.meta.dir, "worker.ts");
  const input = JSON.stringify({ files, metadata: options.metadata ?? [], navigation: options.navigation });
  if (Buffer.byteLength(input) > 32 * 1024 * 1024) throw new Error("RUST_INPUT_TOO_LARGE");
  const directory = mkdtempSync(join(tmpdir(), "semctx-rust-request-"));
  try {
    const requestPath = join(directory, "request.json");
    writeFileSync(requestPath, input);
    const result = spawnSyncWithinBudget(process.execPath, ["run", "--no-env-file", worker, "--supervise", requestPath, String(budgetMs)], {
      encoding: "utf8", timeout: budgetMs + 15_000, maxBuffer: 32 * 1024 * 1024,
    });
    if (result.error !== undefined || result.status !== 0) {
      throw new Error(`RUST_WORKER_FAILED: ${result.error?.message ?? String(result.stderr)}`);
    }
    return RustExtractionSchema.parse(JSON.parse(String(result.stdout)));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
