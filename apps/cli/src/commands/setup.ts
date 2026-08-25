import {
  evaluatePolyglotSetupPolicy,
  setupRepository,
  setupRepositoryAsync,
  type SetupPhaseEvent,
  type SetupRefusedReport,
  type SetupResult,
} from "@semantic-context/app-services";
import { isInitialized, loadConfig } from "@semantic-context/repository-store";
import { runPreset, validatePreset } from "./preset";
import type { ParsedArgs } from "../args";
import { flagBool, flagString } from "../args";
import { info, heading, success, warn, fail, json, c, nowIso } from "../output";
import { parseIndexWorkers } from "./index-cmd";

/**
 * `semctx setup` — one command that makes a repository ready: config + graph index + semantic
 * scaffold + validation. Idempotent and non-destructive (never overwrites an existing config or
 * authored `.sem` files). Live phase progress is emitted via the shared `onPhase` port.
 *
 * The core mutation lives in `@semantic-context/app-services` (`setupRepository`) so the plugin MCP
 * tool can call the same path without a global package install.
 */
interface PreparedCliSetup {
  preset: string | undefined;
  asJson: boolean;
  polyglot: boolean;
  policyRefusal: SetupRefusedReport | null;
  onPhase: ((event: SetupPhaseEvent) => void) | undefined;
  earlyExit?: number;
}

export function runSetup(root: string, args: ParsedArgs): number {
  const prepared = prepareCliSetup(root, args);
  if (prepared.earlyExit !== undefined) return prepared.earlyExit;
  const report = prepared.policyRefusal ?? setupRepository(root, setupOptions(prepared));
  return renderSetup(report, prepared);
}

export async function runSetupAsync(root: string, args: ParsedArgs): Promise<number> {
  const workers = parseIndexWorkers(args);
  const prepared = prepareCliSetup(root, args);
  if (prepared.earlyExit !== undefined) return prepared.earlyExit;
  const report = prepared.policyRefusal
    ?? await setupRepositoryAsync(root, { ...setupOptions(prepared), workers });
  return renderSetup(report, prepared);
}

function prepareCliSetup(root: string, args: ParsedArgs): PreparedCliSetup {
  const preset = flagString(args, "preset");
  const asJson = flagBool(args, "json");
  const polyglot = flagBool(args, "polyglot");

  if (!asJson) heading(`semctx setup  ${c.dim("·")}  ${root}`);

  let policyRefusal: SetupRefusedReport | null = null;

  // Optional host presets (GitHub Action / Claude Code files) remain CLI-only.
  if (preset !== undefined) {
    validatePreset(preset);
    const alreadyInitialized = isInitialized(root);
    if (alreadyInitialized) {
      const config = loadConfig(root);
      policyRefusal = evaluatePolyglotSetupPolicy({
        repositoryRoot: root,
        polyglot,
        alreadyInitialized,
        configVersion: config.version,
      });
    }

    if (policyRefusal === null) {
      if (!asJson) info(c.dim(`  applying preset "${preset}"…`));
      const code = runPreset(root, preset, args, {
        includeConfig: false,
        emitOutput: false,
      });
      if (code !== 0) {
        return { preset, asJson, polyglot, policyRefusal, onPhase: undefined, earlyExit: code };
      }
    }
  }

  return {
    preset,
    asJson,
    polyglot,
    policyRefusal,
    onPhase: asJson
      ? undefined
      : (event) => {
        switch (event.phase) {
          case "config":
            info(
              `  ${c.green("ok")} config    ${
                event.detail === "written" ? c.dim("written") : c.dim("existing, kept")
              }`,
            );
            return;
          case "semantic":
            info(
              `  ${c.green("ok")} semantic  ${
                event.created > 0
                  ? `${event.created} file(s) scaffolded ${c.dim("(.semctx/semantic/, versioned)")}`
                  : c.dim("already present")
              }`,
            );
            return;
          case "index":
            if (event.stage === "start") {
              if (event.selectedFiles === 0) {
                info(`  ${c.yellow("!!")} index     ${c.yellow("no analyzable files selected")} under ${root}`);
              } else {
                const langs = Object.entries(event.selectedByLanguage)
                  .filter(([, n]) => n > 0)
                  .map(([language, n]) => `${language}:${n}`)
                  .join(", ");
                info(
                  `  ${c.dim("··")} index     analyzing ${c.bold(String(event.selectedFiles))} selected file(s)`
                  + `${langs.length > 0 ? c.dim(` (${langs})`) : ""}…`,
                );
              }
              return;
            }
            info(
              `  ${c.green("ok")} index     ${c.bold(String(event.nodes))} nodes, `
              + `${c.bold(String(event.edges))} edges, ${c.bold(String(event.claims))} claims`,
            );
            return;
          case "check":
            info(
              `  ${event.ok ? c.green("ok") : c.red("!!")} check     ${
                event.ok ? "model consistent" : `${event.errors} error(s)`
              }`,
            );
            return;
          case "analysis":
            if (event.coverageStatus !== undefined) {
              const healthColor = !event.ready
                ? c.red
                : event.coverageStatus === "complete"
                  ? c.green
                  : c.yellow;
              info(
                `  ${!event.ready
                  ? c.red("!!")
                  : event.coverageStatus === "complete"
                    ? c.green("ok")
                    : c.yellow("!!")} analysis  ${healthColor(event.coverageStatus)}`,
              );
            }
            return;
        }
        },
  };
}

function setupOptions(prepared: PreparedCliSetup): {
  polyglot: boolean;
  now: string;
  onPhase: PreparedCliSetup["onPhase"];
} {
  return {
    polyglot: prepared.polyglot,
    now: nowIso(),
    onPhase: prepared.onPhase,
  };
}

function renderSetup(report: SetupResult, prepared: PreparedCliSetup): number {
  const { asJson, preset } = prepared;

  if (report.kind === "setup_refused") {
    if (asJson) {
      // Canonical SetupResult envelope (same fields as MCP structured content).
      json({ ...report, preset: preset ?? null });
      return 1;
    }
    fail(report.reason);
    for (const step of report.nextSteps) info(c.dim(`  → ${step}`));
    return 1;
  }

  if (asJson) {
    // Canonical SetupRepositoryReport + CLI-only preset annotation.
    json({
      ...report,
      preset: preset ?? null,
    });
    return report.setupReady ? 0 : 1;
  }

  info("");
  if (report.parallelism !== undefined) {
    info(c.dim(`TypeScript analysis: ${report.parallelism.used} worker(s), ${report.parallelism.mode}`));
  }
  if (report.nodes === 0) {
    warn(
      report.selection.configVersion === 1
        ? "index found 0 nodes — config v1 keeps legacy discovery and does not apply include; use 'semctx setup --polyglot' in a new workspace or migrate explicitly to config v2."
        : "index found 0 nodes — review v2 include/exclude globs and language modes, then re-run 'semctx setup'.",
    );
  }

  const coverage = report.indexHealth.coverage as { status?: string } | undefined;
  const coverageStatus = coverage?.status;
  const reasons = report.indexHealth.reasonSummary as readonly unknown[] | undefined;
  if (report.setupReady) {
    const analysisQualification =
      coverageStatus !== undefined && coverageStatus !== "complete"
        ? ` (analysis ${coverageStatus})`
        : "";
    success(`ready${analysisQualification}`);
    if (coverageStatus !== undefined && coverageStatus !== "complete") {
      warn(
        "setup succeeded, but incomplete analysis cannot justify negative conclusions; "
        + "run 'semctx index-health --json' for the exact gates and reasons.",
      );
    }
    info(c.dim("Next: open a change and verify it —"));
    info(c.dim("  semctx change open change.my-change --preserves <invariant-ids>"));
    info(c.dim("  # edit code, then:  semctx change verify change.my-change --base origin/main"));
    info(c.dim("Plugin path: MCP semctx_setup { repositoryRoot, confirm: true }"));
  } else if (!report.check.ok) {
    fail("setup completed with model issues — run 'semctx semantic check' for details");
  } else {
    fail(
      "setup completed, but analysis is not ready — "
      + "run 'semctx index-health --json' for the exact gates and reasons.",
    );
    if (reasons !== undefined && reasons.length > 0) {
      info(c.dim(`  reasons: ${reasons.map(String).join(", ")}`));
    }
  }
  return report.setupReady ? 0 : 1;
}
