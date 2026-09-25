import {
  SETUP_POLYGLOT_V1_REFUSE_REASON_CODE,
  planSetupRepository,
  setupRepository,
  type SetupRepositoryReport,
  type SetupRefusedReport,
  type SetupResult,
} from "@semantic-context/app-services";

export { SETUP_POLYGLOT_V1_REFUSE_REASON_CODE };

/** Agent-facing polyglot input description (must name the exact reasonCode). */
export const SETUP_POLYGLOT_INPUT_DESCRIPTION =
  "when writing a FRESH config, use polyglot v2 glob selection. If a non-v2 config already exists, polyglot:true is REFUSED (kind setup_refused / reasonCode "
  + SETUP_POLYGLOT_V1_REFUSE_REASON_CODE
  + " / verdict SETUP_REFUSED) — migrate .semctx/config.json to v2 explicitly; it does not silently ignore or overwrite";

export interface SetupPreflightReport {
  schemaVersion: 1;
  kind: "setup_preflight";
  repositoryRoot: string;
  initialized: boolean;
  confirmRequired: true;
  /**
   * Human authorization is required before any write. Structured `next` never
   * embeds `confirm: true` so agents cannot auto-follow the preflight payload.
   */
  requiresUserAuthorization: true;
  message: string;
  next: {
    tool: "semctx_setup";
    /** Arguments template without confirm — host must set confirm:true only after user yes. */
    arguments: {
      repositoryRoot: string;
      polyglot?: boolean;
    };
  };
}

export type SetupToolResult =
  | SetupPreflightReport
  | SetupRepositoryReport
  | SetupRefusedReport;

/**
 * True when the structured body is a completed setup that agents must treat as failure.
 * Wire transport still returns isError false (ADR 0012); agents must read kind/verdict.
 */
export function isSetupDomainFailure(body: SetupToolResult): boolean {
  return body.kind === "setup_refused"
    || (body.kind === "setup" && body.verdict === "SETUP_NOT_READY");
}

/** Agent success gate: only a full setup with SETUP_READY (ignore isError for domain outcomes). */
export function isSetupAgentSuccess(body: SetupToolResult): boolean {
  return body.kind === "setup" && body.verdict === "SETUP_READY";
}

/**
 * Plugin-native workspace bootstrap.
 *
 * - `confirm: false` (default) → dry preflight only (no writes).
 * - `confirm: true` → full setup via shared `setupRepository` (no global CLI install).
 *
 * All outcomes are ordinary schema-valid structured results (ADR 0012: no handler-authored
 * isError / no structuredContent on catalogue errors), except catalogue failures that throw
 * (e.g. CONFIG_INVALID on unreadable/schema-invalid config when `.semctx/` already exists):
 * - `kind: "setup" && verdict: "SETUP_READY"` → agent success
 * - `setup_refused` / `SETUP_NOT_READY` → domain failure; read reason/nextSteps/indexHealth
 *
 * Polyglot-vs-config-version refusal is owned by app-services (`evaluatePolyglotSetupPolicy`).
 * This adapter may load config for no-write preflight but must not reconstruct refuse payloads.
 *
 * Preflight never embeds `confirm: true` in `next.arguments` (human authorization is not
 * machine-auto-followable). When initialized, config is always loaded so invalid config
 * fails closed as catalogue CONFIG_INVALID instead of a healthy preflight.
 *
 * Verdict values are namespaced (`SETUP_*`) so they never collide with Plane C `READY`/`BLOCKED`.
 */
export function setupTool(
  root: string,
  input: { confirm?: boolean; polyglot?: boolean; now?: string } = {},
): SetupToolResult {
  // The shared read-only planner owns deterministic workspace/config/scaffold/.gitignore
  // validation. Run it before both the unconfirmed response and every confirmed write.
  const plan = planSetupRepository(root, {
    ...(input.polyglot === true ? { polyglot: true } : {}),
  });
  if (plan.kind === "setup_refused") return plan;

  if (input.confirm !== true) {
    return {
      schemaVersion: 1,
      kind: "setup_preflight",
      repositoryRoot: root,
      initialized: plan.alreadyInitialized,
      confirmRequired: true,
      requiresUserAuthorization: true,
      message: plan.alreadyInitialized
        ? "Workspace already has .semctx/. Preflight only — no writes. After the user explicitly authorises writes, re-call semctx_setup with confirm:true to re-index and re-validate (idempotent; does not overwrite authored .sem files or an existing config). Do not auto-follow this response as a write."
        : "Workspace is not initialized. Preflight only — no writes. After the user explicitly authorises writes, re-call semctx_setup with confirm:true to write .semctx/, scaffold semantic files, and build the deterministic index. Do not auto-follow this response as a write. No global semctx package install is required when using the plugin MCP.",
      next: {
        tool: "semctx_setup",
        arguments: {
          repositoryRoot: root,
          // confirm intentionally omitted — must be set by the host after user authorisation
          ...(input.polyglot === true ? { polyglot: true } : {}),
        },
      },
    };
  }

  const result: SetupResult = setupRepository(root, {
    ...(input.polyglot === true ? { polyglot: true } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  return result;
}
