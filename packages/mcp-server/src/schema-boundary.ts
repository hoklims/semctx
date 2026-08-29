import type { ZodType, ZodTypeDef } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod-v4";

/**
 * Convert a business-layer Zod 3 schema into a Zod 4 schema before exposing it
 * to the MCP v2 SDK. The SDK therefore receives only its supported Standard
 * Schema boundary while the rest of the monorepo can remain on Zod 3.
 */
export function mcpSchema<Output, Input = Output>(
  schema: ZodType<Output, ZodTypeDef, Input>,
): z.ZodType<Output, Input> {
  const jsonSchema = zodToJsonSchema(schema, {
    $refStrategy: "none",
    target: "jsonSchema7",
  });

  const converted = z.fromJSONSchema(
    jsonSchema as Parameters<typeof z.fromJSONSchema>[0],
  );

  // JSON Schema carries the portable structural contract, but cannot express
  // every Zod refinement (for example canonical ordering or cross-field
  // coherence). Re-run the source schema after conversion so the MCP boundary
  // accepts exactly the business contract rather than a structural superset.
  return converted.superRefine((value, context) => {
    const sourceResult = schema.safeParse(value);
    if (sourceResult.success) return;

    for (const issue of sourceResult.error.issues) {
      context.addIssue({
        code: "custom",
        path: issue.path,
        message: issue.message,
        input: value,
      });
    }
  }) as z.ZodType<Output, Input>;
}
