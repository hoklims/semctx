import { z } from "zod";
import type { Sha256Hash } from "./types";

export const Sha256HashSchema: z.ZodType<Sha256Hash> = z.string()
  .regex(/^sha256:[0-9a-f]{64}$/, "expected sha256:<64 lowercase hex>") as z.ZodType<Sha256Hash>;
