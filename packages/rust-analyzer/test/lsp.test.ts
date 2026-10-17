import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { join } from "node:path";
import { RustLspClient } from "../src/lsp";

function client(mode = "ok"): RustLspClient {
  return new RustLspClient([process.execPath, "run", join(import.meta.dir, "fixtures/lsp-server.ts"), mode], {
    cwd: import.meta.dir, budgetMs: mode === "hang" ? 100 : 5_000,
  });
}

test("frames UTF-8 JSON-RPC over a real child process with consecutive responses", async () => {
  const connection = client();
  try {
    expect(await connection.request("initialize", {})).toEqual({ text: "🦀 café", method: "initialize" });
    expect(await connection.request("textDocument/definition", {})).toEqual({ text: "🦀 café", method: "textDocument/definition" });
  } finally { await connection.close(); }
});

for (const [mode, reason] of [["corrupt", "RUST_LSP_PROTOCOL"], ["hang", "RUST_LSP_TIMEOUT"], ["exit", "RUST_LSP_EXIT"]] as const) {
  test(`refuses ${mode} without a successful empty result`, async () => {
    const connection = client(mode);
    try { await rejects(connection.request("initialize", {}), new RegExp(reason)); }
    finally { await connection.close(); }
  });
}
