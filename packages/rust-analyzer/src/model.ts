import { z } from "zod";
import { RustNavigationConfigSchema } from "@semantic-context/core";

export const RustSourceSchema = z.object({
  relPath: z.string().min(1).refine((path) => !/^[A-Za-z]:/.test(path) && !path.includes("\\")
    && path.split("/").every((part) => part !== "" && part !== "." && part !== ".."), "RUST_SOURCE_PATH_INVALID"),
  source: z.string(),
});

export const RustRangeSchema = z.object({
  startOffset: z.number().int().nonnegative(), endOffset: z.number().int().nonnegative(),
  startLine: z.number().int().positive(), endLine: z.number().int().positive(),
  startColumn: z.number().int().positive(), endColumn: z.number().int().positive(),
});

const RustMarkerSchema = z.object({
  tag: z.enum(["capability", "invariant", "contract", "risk", "boundedContext", "tag"]),
  slug: z.string(), statement: z.string().optional(), range: RustRangeSchema,
});

const RustSymbolSchema = z.object({
  relPath: z.string(), name: z.string(),
  kind: z.enum(["function", "type", "enum", "symbol", "test", "module"]),
  rustKind: z.string(), scope: z.array(z.string()), visibility: z.string(),
  range: RustRangeSchema, nameRange: RustRangeSchema,
  attributes: z.array(z.string()), markers: z.array(RustMarkerSchema),
});

const RustLimitationSchema = z.object({
  relPath: z.string(),
  kind: z.enum(["parse-error", "glob-import", "conditional-source", "macro-expansion"]),
  range: RustRangeSchema,
});

export const RustExtractionSchema = z.object({
  symbols: z.array(RustSymbolSchema), limitations: z.array(RustLimitationSchema),
  queries: z.array(z.object({
    relPath: z.string(), kind: z.enum(["import", "call"]), scope: z.array(z.string()),
    range: RustRangeSchema, target: RustRangeSchema,
  })),
  navigation: z.object({
    relations: z.array(z.object({ queryIndex: z.number().int().nonnegative(), symbolIndex: z.number().int().nonnegative() })),
    unresolved: z.array(z.object({ queryIndex: z.number().int().nonnegative(), reason: z.string() })),
    identity: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  }).optional(),
});

export const RustRequestSchema = z.object({
  files: z.array(RustSourceSchema), metadata: z.array(RustSourceSchema),
  navigation: RustNavigationConfigSchema.optional(),
});

export type RustSource = z.infer<typeof RustSourceSchema>;
export type RustRange = z.infer<typeof RustRangeSchema>;
export type RustMarker = z.infer<typeof RustMarkerSchema>;
export type RustSymbol = z.infer<typeof RustSymbolSchema>;
export type RustLimitation = z.infer<typeof RustLimitationSchema>;
export type RustExtraction = z.infer<typeof RustExtractionSchema>;
