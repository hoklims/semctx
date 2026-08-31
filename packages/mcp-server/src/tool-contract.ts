import {
  type CallToolResult,
  fromJsonSchema,
  type JsonSchemaType,
  type JsonSchemaValidator,
  type jsonSchemaValidator,
  type McpServer,
  type RegisteredTool,
  type ServerContext,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import {
  isSemctxError,
  type SemctxErrorCode,
} from "@semantic-context/core";
import { z } from "zod-v4";
import {
  ToolPublicError,
  type ToolPublicErrorCode,
} from "./public-tool-error";
import { TOOL_OUTPUT_SCHEMAS } from "./tool-output-schemas";
import { requestTrace, type RequestTrace } from "./trace-context";

const TOOL_NAMES = [
  "semctx_verify_change",
  "semctx_inspect",
  "semctx_prepare_task",
  "semctx_setup",
  "semctx_semantic_check",
  "semctx_semantic_slice",
  "semctx_change_open",
  "semctx_change_update",
  "semctx_change_verify",
  "semctx_change_close",
  "semctx_semantic_inspect",
  "semctx_handoff",
  "semctx_resume",
  "semctx_index_health",
  "semctx_cli_compatibility",
  "semctx_control_status",
  "semctx_control_agent_lifecycle",
  "semctx_control_authority",
  "semctx_control_trace",
  "semctx_control_graph",
  "semctx_control_traversal",
  "semctx_control_refinement_coverage",
  "semctx_control_impact",
  "semctx_control_explain_why",
  "semctx_control_compare_architecture",
  "control_authorize_transition",
  "control_authorize_step",
  "control_authorize_deletion",
  "semctx_control_plan",
  "semctx_control_bind_scope",
  "semctx_control_frame_task",
  "semctx_control_plan_change",
  "semctx_control_reconcile_diff",
  "semctx_control_handoff",
  "semctx_control_resume",
  "semctx_control_target_propose",
  "semctx_control_explorer",
  "semctx_control_verify_authorization",
] as const;

export type SemctxToolName = (typeof TOOL_NAMES)[number];

type ToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const WRITER: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
const IDEMPOTENT_WRITER: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const WRITER_NAMES = new Set<SemctxToolName>([
  "semctx_prepare_task",
  "semctx_change_open",
  "semctx_change_update",
  "semctx_change_close",
  "semctx_handoff",
  "semctx_control_target_propose",
]);

const IDEMPOTENT_WRITER_NAMES = new Set<SemctxToolName>([
  "semctx_setup",
  "semctx_control_handoff",
]);

const TOOL_EFFECTS = Object.fromEntries(
  TOOL_NAMES.map((name) => [
    name,
    IDEMPOTENT_WRITER_NAMES.has(name)
      ? IDEMPOTENT_WRITER
      : WRITER_NAMES.has(name)
        ? WRITER
        : READ_ONLY,
  ]),
) as Record<SemctxToolName, ToolAnnotations>;

type ToolResult = CallToolResult & {
  isError?: boolean;
  structuredContent?: unknown;
};

/**
 * Successful handler results only (ADR 0012). Handlers must not publish isError;
 * domain refusals are ordinary schema-valid results with a negative verdict/kind.
 */
type ToolSuccessResult = CallToolResult & {
  isError?: false;
  structuredContent?: unknown;
};

const PUBLIC_ERROR_MESSAGE_LIMIT = 512;
const PUBLIC_INPUT_MAX_DEPTH = 64;
const PUBLIC_INPUT_MAX_NODES = 100_000;
const PUBLIC_INPUT_MAX_ARRAY_LENGTH = 50_000;
const PUBLIC_INPUT_MAX_KEY_LENGTH = 1_024;

type PublicErrorCode =
  | SemctxErrorCode
  | ToolPublicErrorCode;

const PUBLIC_ERROR_MESSAGES: Record<PublicErrorCode, string> = {
  CONFIG_NOT_FOUND: "Semctx configuration was not found",
  CONFIG_INVALID: "Semctx configuration is invalid",
  REPO_NOT_INDEXED: "Repository is not indexed",
  TASK_NOT_FOUND: "Task was not found",
  INVALID_TASK_INPUT: "Tool input is invalid",
  ANALYSIS_FAILED: "Semantic analysis failed",
  STORE_ERROR: "Repository state is unavailable",
  GIT_ERROR: "Repository Git state is unavailable",
  GIT_BASE_UNAVAILABLE: "Repository Git base is unavailable",
  CONTROL_INPUTS_UNSAFE: "Control inputs are unsafe",
  IO_ERROR: "Repository data could not be read or written",
  UNSUPPORTED: "Operation is unsupported",
  INTERNAL_ERROR: "The tool could not complete the request",
  INVALID_ARGUMENTS: "Tool arguments are invalid",
  INVALID_OUTPUT: "Tool output did not match its public contract",
  REPOSITORY_ROOT_INVALID: "repository root must be absolute",
  REPOSITORY_ROOT_UNAVAILABLE:
    "repository root does not exist or is not accessible",
  REPOSITORY_ROOT_MISMATCH:
    "repository root does not match the server-bound root",
};

// SDK v2 validates registered input schemas before invoking the callback and
// emits its own unbounded text on failure. The adapter therefore advertises the
// real JSON Schema but defers execution-time validation to ToolRegistrar below.
// Every semctx production tool registers through this class, and tests lock that
// no handler runs before the raw-budget, fail-fast, and Zod gates succeed.
const PASS_THROUGH_VALIDATOR: jsonSchemaValidator = {
  getValidator<T>(_schema: JsonSchemaType): JsonSchemaValidator<T> {
    return (input: unknown) => ({
      valid: true,
      data: input as T,
      errorMessage: undefined,
    });
  },
};

const FAIL_FAST_VALIDATOR = new CfWorkerJsonSchemaValidator({
  draft: "2020-12",
  shortcircuit: true,
});

type PublicFailure = {
  code: PublicErrorCode;
  error: string;
};

function publicFailure(error: unknown): PublicFailure {
  let candidate: unknown;
  try {
    candidate = error instanceof ToolPublicError
      ? error.code
      : isSemctxError(error)
        ? error.code
        : "INTERNAL_ERROR";
  } catch {
    candidate = "INTERNAL_ERROR";
  }
  const code = typeof candidate === "string"
    && Object.hasOwn(PUBLIC_ERROR_MESSAGES, candidate)
    ? candidate as PublicErrorCode
    : "INTERNAL_ERROR";

  return { code, error: PUBLIC_ERROR_MESSAGES[code] };
}

for (const message of Object.values(PUBLIC_ERROR_MESSAGES)) {
  if (message.length > PUBLIC_ERROR_MESSAGE_LIMIT) {
    throw new Error("public MCP error catalogue exceeds its message budget");
  }
}

function errorResult(error: unknown): ToolResult {
  const failure = publicFailure(error);
  return {
    content: [{
      type: "text",
      text: JSON.stringify(failure),
    }],
    isError: true,
  };
}

type ToolConfig<InputArgs extends z.ZodRawShape> = {
  title?: string;
  description?: string;
  inputSchema: InputArgs;
  strictInput?: boolean;
  outputSchema?: z.ZodType;
  annotations?: ToolAnnotations;
  icons?: Array<Record<string, unknown>>;
  _meta?: Record<string, unknown>;
};

type ToolCallback<InputArgs extends z.ZodRawShape> = (
  args: z.infer<z.ZodObject<InputArgs>>,
  ctx: ServerContext,
) => ToolSuccessResult | Promise<ToolSuccessResult>;

function outputValidationError(
  issues: ReadonlyArray<unknown>,
): Error {
  return new ToolPublicError("INVALID_OUTPUT", { cause: issues });
}

function withStructuredContent(
  name: SemctxToolName,
  outputSchema: z.ZodType,
  result: ToolSuccessResult,
): ToolResult {
  const text = result.content.find((item) => item.type === "text");
  let structuredContent = result.structuredContent;

  if (text?.type === "text") {
    try {
      structuredContent = JSON.parse(text.text);
    } catch {
      throw new Error(`${name} produced a successful result without valid JSON text`);
    }
  } else if (structuredContent === undefined) {
    throw new Error(`${name} produced a successful result without structured content`);
  }

  const validation = outputSchema.safeParse(structuredContent);
  if (!validation.success) {
    throw outputValidationError(validation.error.issues);
  }

  return { ...result, structuredContent };
}

export interface ToolRegistrarOptions {
  onRequestContext?: (trace: RequestTrace) => unknown;
  /** Receives local failure details; it must never write to the MCP response. */
  onInternalDiagnostic?: (event: ToolFailureDiagnostic) => unknown;
}

export interface ToolFailureDiagnostic {
  toolName: SemctxToolName;
  phase: "request_context" | "input_validation" | "handler" | "output_validation";
  cause: unknown;
  publicFailure?: PublicFailure;
}

function reportInternalDiagnostic(
  observer: ToolRegistrarOptions["onInternalDiagnostic"],
  event: ToolFailureDiagnostic,
): void {
  if (observer === undefined) {
    return;
  }

  try {
    void Promise.resolve(observer(event)).catch(() => undefined);
  } catch {
    // Diagnostics are advisory and must not escape the public error boundary.
  }
}

function observeRequestContext(
  observer: ToolRegistrarOptions["onRequestContext"],
  diagnosticObserver: ToolRegistrarOptions["onInternalDiagnostic"],
  toolName: SemctxToolName,
  trace: RequestTrace,
): void {
  if (observer === undefined) {
    return;
  }

  const report = (cause: unknown): void => {
    reportInternalDiagnostic(diagnosticObserver, {
      toolName,
      phase: "request_context",
      cause,
    });
  };

  try {
    void Promise.resolve(observer(trace)).catch(report);
  } catch (cause) {
    report(cause);
  }
}

type PreparedInputSchema<InputArgs extends z.ZodRawShape> = {
  advertised: StandardSchemaWithJSON<unknown, unknown>;
  parse: (input: unknown) => Promise<z.infer<z.ZodObject<InputArgs>>>;
};

function inputWithinPublicBudget(input: unknown): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{
    value: input,
    depth: 0,
  }];
  const visited = new WeakSet<object>();
  let nodes = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      break;
    }
    nodes += 1;
    if (nodes > PUBLIC_INPUT_MAX_NODES || current.depth > PUBLIC_INPUT_MAX_DEPTH) {
      return false;
    }
    if (typeof current.value !== "object" || current.value === null) {
      continue;
    }
    if (visited.has(current.value)) {
      return false;
    }
    visited.add(current.value);

    if (Array.isArray(current.value)) {
      if (current.value.length > PUBLIC_INPUT_MAX_ARRAY_LENGTH) {
        return false;
      }
      for (const value of current.value) {
        pending.push({ value, depth: current.depth + 1 });
      }
      continue;
    }

    for (const [key, value] of Object.entries(current.value)) {
      if (key.length > PUBLIC_INPUT_MAX_KEY_LENGTH) {
        return false;
      }
      pending.push({ value, depth: current.depth + 1 });
    }
  }

  return true;
}

function prepareInputSchema<InputArgs extends z.ZodRawShape>(
  shape: InputArgs,
  strictInput = false,
): PreparedInputSchema<InputArgs> {
  const schema = strictInput
    ? z.object(shape).strict()
    : z.object(shape);
  const document = z.toJSONSchema(schema, {
    io: "input",
    target: "draft-2020-12",
  }) as JsonSchemaType;
  const advertised = fromJsonSchema<unknown>(
    document,
    PASS_THROUGH_VALIDATOR,
  );
  const failFast = FAIL_FAST_VALIDATOR.getValidator<unknown>(document);

  return {
    advertised,
    async parse(input) {
      if (!inputWithinPublicBudget(input)) {
        throw new ToolPublicError("INVALID_ARGUMENTS", {
          cause: "public input budget exceeded",
        });
      }

      const structural = failFast(input);
      if (!structural.valid) {
        throw new ToolPublicError("INVALID_ARGUMENTS", {
          cause: structural.errorMessage,
        });
      }

      const parsed = await schema.safeParseAsync(structural.data);
      if (!parsed.success) {
        throw new ToolPublicError("INVALID_ARGUMENTS", {
          cause: parsed.error.issues,
        });
      }

      return parsed.data;
    },
  };
}

/** One registration boundary for metadata, effects, tracing, and structured results. */
export class ToolRegistrar {
  constructor(
    private readonly server: McpServer,
    private readonly options: ToolRegistrarOptions = {},
  ) {}

  registerTool<InputArgs extends z.ZodRawShape>(
    name: SemctxToolName,
    config: ToolConfig<InputArgs>,
    callback: ToolCallback<InputArgs>,
  ): RegisteredTool {
    const { strictInput = false, ...toolConfig } = config;
    const outputSchema = config.outputSchema ?? TOOL_OUTPUT_SCHEMAS[name];
    const inputSchema = prepareInputSchema(config.inputSchema, strictInput);
    const configuredUi =
      typeof config._meta?.["ui"] === "object" && config._meta["ui"] !== null
        ? config._meta["ui"] as Record<string, unknown>
        : {};
    const registerTool = this.server.registerTool.bind(this.server) as unknown as (
      toolName: string,
      toolConfig: Record<string, unknown>,
      toolCallback: (args: unknown, ctx: ServerContext) => Promise<ToolResult>,
    ) => RegisteredTool;

    return registerTool(
      name,
      {
        ...toolConfig,
        inputSchema: inputSchema.advertised,
        outputSchema,
        annotations: TOOL_EFFECTS[name],
        _meta: {
          ...config._meta,
          ui: {
            ...configuredUi,
            visibility: configuredUi["visibility"] ?? ["model"],
          },
        },
      },
      async (args, ctx) => {
        let phase: ToolFailureDiagnostic["phase"] = "input_validation";
        try {
          const parsedArgs = await inputSchema.parse(args);
          observeRequestContext(
            this.options.onRequestContext,
            this.options.onInternalDiagnostic,
            name,
            requestTrace(ctx),
          );
          phase = "handler";
          const result = await callback(
            parsedArgs,
            ctx,
          );
          // ADR 0012: a handler cannot publish its own isError payload. Domain
          // outcomes (e.g. setup_refused / SETUP_NOT_READY) are ordinary schema-valid
          // success-shaped results; only the catalogue path may set isError:true.
          if ((result as ToolResult).isError === true) {
            throw new ToolPublicError("INTERNAL_ERROR", {
              cause: "tool callback returned isError",
            });
          }
          phase = "output_validation";
          return withStructuredContent(
            name,
            outputSchema,
            result,
          );
        } catch (error) {
          reportInternalDiagnostic(this.options.onInternalDiagnostic, {
            toolName: name,
            phase,
            cause: error,
            publicFailure: publicFailure(error),
          });
          return errorResult(error);
        }
      },
    );
  }
}
