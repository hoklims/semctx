export type WitnessVariant = "activate" | "control";
export type ExpectedHelperResult =
  | { kind: "boolean"; value: boolean }
  | { kind: "string"; value: string }
  | { kind: "undefined" }
  | { kind: "node"; syntaxKind: string; text?: string }
  | { kind: "declarations"; syntaxKinds: string[]; declarationPaths?: string[] };

export type NativeExpectation = (
  | { kind: "helper-return"; variant: WitnessVariant; consumerIndex: number; argumentText: string; argumentPath?: string; expected: ExpectedHelperResult }
  | { kind: "syntax"; variant: WitnessVariant; syntaxKind: string; text?: string; minimumCount: number }
  | { kind: "symbol-origin"; variant: WitnessVariant; nodeText: string; origin: "default-library" | "retained" | "absent" }
  | { kind: "type"; variant: WitnessVariant; nodeText: string; callable?: boolean; constructible?: boolean; union?: boolean; intersection?: boolean }
) & { alternatives?: string[]; sourcePath?: string };

export type ContractWitness = {
  index: number;
  idSuffix: string;
  path: string;
  files: Record<string, string>;
  controlFiles: Record<string, string>;
  requiredAlternatives: string[];
  nativeExpectations: NativeExpectation[];
};

export type ContractWitnessLimitation = {
  index: number;
  alternative: string;
  reason: string;
  neededEvidence: string;
};

export function witness(
  index: number,
  idSuffix: string,
  activate: string | Record<string, string>,
  control: string | Record<string, string>,
  requiredAlternatives: string[],
  nativeExpectations: NativeExpectation[] = [],
): ContractWitness {
  return {
    index, idSuffix, path: typeof activate === "string" ? "main.ts" : Object.keys(activate).find(path => /^main\.[cm]?[jt]sx?$/.test(path)) ?? Object.keys(activate)[0] ?? "main.ts",
    files: typeof activate === "string" ? { "main.ts": activate } : activate,
    controlFiles: typeof control === "string" ? { "main.ts": control } : control,
    requiredAlternatives, nativeExpectations,
  };
}

export function helperResult(
  consumerIndex: number,
  variant: WitnessVariant,
  argumentText: string,
  expected: ExpectedHelperResult,
  alternatives?: string[],
  argumentPath?: string,
): NativeExpectation {
  return { kind: "helper-return", consumerIndex, variant, argumentText, expected, ...(alternatives === undefined ? {} : { alternatives }), ...(argumentPath === undefined ? {} : { argumentPath }) };
}
