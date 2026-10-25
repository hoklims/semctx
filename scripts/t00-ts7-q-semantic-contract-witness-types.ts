export type WitnessVariant = "activate" | "control";
export type NativeNodeSelector = { nodeText: string; sourcePath?: string; syntaxKind?: string; nativeByteStart?: number; nativeByteEnd?: number };
export type NativeIdentityStep =
  | { op: "callSignature" | "constructSignature" | "parameter" | "union" | "intersection" | "declaration"; index: number }
  | { op: "symbol" | "type" | "aliasTarget" | "numberIndexType" | "baseConstraint" | "returnType" | "shorthandValueSymbol" }
  | { op: "property"; name: string }
  | { op: "symbolType"; location: "signatureDeclaration" | NativeNodeSelector };
export type NativeIdentitySelector = NativeNodeSelector & { target: "type" | "symbol" | "aliasedSymbol" | "shorthandValueSymbol"; steps?: NativeIdentityStep[] };
export type ExpectedHelperResult =
  | { kind: "boolean"; value: boolean }
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "undefined" }
  | { kind: "node"; syntaxKind: string; text?: string; path?: string; start?: number; end?: number; nativeByteStart?: number; nativeByteEnd?: number; defaultLibrary?: boolean; rest?: boolean }
  | { kind: "declarations"; syntaxKinds: string[]; declarationPaths?: string[] }
  | { kind: "array"; values: ExpectedHelperResult[] }
  | { kind: "object"; properties: Record<string, ExpectedHelperResult> }
  | { kind: "symbol"; native?: NativeIdentitySelector; name?: string; declarations?: ExpectedHelperResult[]; defaultLibrary?: boolean }
  | { kind: "type"; native?: NativeIdentitySelector; flagsNames?: string[]; callSignatureCount?: number; constructSignatureCount?: number; callable?: boolean; constructible?: boolean; union?: boolean; intersection?: boolean; unionTypes?: ExpectedHelperResult[]; intersectionTypes?: ExpectedHelperResult[]; baseConstraintPresent?: boolean; baseConstraint?: ExpectedHelperResult; symbol?: ExpectedHelperResult };

export type HelperArgumentConstraints = {
  argumentText?: string;
  argumentPath?: string;
  argumentStart?: number;
  argumentEnd?: number;
  argument?: ExpectedHelperResult;
  argumentConstraints?: { position: number; expected: ExpectedHelperResult }[];
};
export type NativeExpectation = (
  | ({ kind: "helper-return"; variant: WitnessVariant; consumerIndex: number; expected: ExpectedHelperResult } & HelperArgumentConstraints)
  | { kind: "syntax"; variant: WitnessVariant; syntaxKind: string; text?: string; minimumCount: number; nativeByteStart?: number; nativeByteEnd?: number }
  | { kind: "helper-descendants-absent"; variant: WitnessVariant; consumerIndex: number; parent: NativeNodeSelector }
  | ({ kind: "symbol-origin"; variant: WitnessVariant; origin: "default-library" | "retained" | "absent" } & NativeNodeSelector)
  | ({ kind: "type"; variant: WitnessVariant; callable?: boolean; constructible?: boolean; union?: boolean; intersection?: boolean } & NativeNodeSelector)
) & { alternatives?: string[]; sourcePath?: string };

export type HelperReturnExpectation = Extract<NativeExpectation, { kind: "helper-return" }>;

export type ContractWitness = {
  index: number;
  idSuffix: string;
  path: string;
  files: Record<string, string>;
  controlFiles: Record<string, string>;
  roles?: Record<string, "source" | "test">;
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
  argument: string | ExpectedHelperResult,
  expected: ExpectedHelperResult,
  alternatives?: string[],
  argumentPath?: string,
): HelperReturnExpectation {
  return { kind: "helper-return", consumerIndex, variant, ...(typeof argument === "string" ? { argumentText: argument } : { argument }), expected, ...(alternatives === undefined ? {} : { alternatives }), ...(argumentPath === undefined ? {} : { argumentPath }) };
}
