import { extractRust } from "./index";
import { RustRequestSchema } from "./model";
import { resolveRustNavigation } from "./navigation";
import { runProcessWithinBudget } from "../../../plugins/shared/hooks/process-budget.mjs";

try {
  const [mode, requestPath, rawBudget] = process.argv.slice(2);
  if (requestPath === undefined) throw new Error("RUST_REQUEST_MISSING");
  if (mode === "--supervise") {
    const budgetMs = Number(rawBudget);
    if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 600_000) throw new Error("RUST_BUDGET_INVALID");
    const outcome = await runProcessWithinBudget([process.execPath, "run", "--no-env-file", import.meta.path, "--analyze", requestPath], {
      cwd: import.meta.dir, budgetMs, maxBytes: 32 * 1024 * 1024,
    });
    if (outcome.kind === "timeout") throw new Error("RUST_WORKER_TIMEOUT");
    if (outcome.exitCode !== 0) throw new Error(outcome.stderr);
    await Bun.write(Bun.stdout, outcome.stdout);
  } else if (mode === "--analyze") {
    const request = RustRequestSchema.parse(JSON.parse(await Bun.file(requestPath).text()));
    const extraction = await extractRust(request.files);
    if (request.navigation !== undefined) {
      extraction.navigation = await resolveRustNavigation({ files: request.files, metadata: request.metadata, extraction, config: request.navigation });
    }
    await Bun.write(Bun.stdout, JSON.stringify(extraction));
  } else {
    throw new Error("RUST_WORKER_MODE_INVALID");
  }
} catch (error) {
  await Bun.write(Bun.stderr, error instanceof Error ? error.message : "RUST_WORKER_FAILED");
  process.exitCode = 1;
}
