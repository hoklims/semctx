import { createObservedDiffHunkV1, frameObservedDiffHunkV1 } from "../../src/hashing";

const rawHunkBytes = new TextEncoder().encode("@@ -1,2 +1,2 @@\n-old\n+new\n keep\n");
const input = {
  repositoryIdentity: "repo:semctx",
  normalizedPath: "packages/demo.txt",
  oldRange: { start: 1, lines: 2 },
  newRange: { start: 1, lines: 2 },
  oldBlobId: null,
  newBlobId: "abc123",
  rawHunkBytes,
} as const;

export const OBSERVED_DIFF_HUNK_V1_CONFORMANCE = Object.freeze({
  input,
  framedHex: Buffer.from(frameObservedDiffHunkV1(input)).toString("hex"),
  expectedFramedHex:
    "53454d4354584c30000000010000000b7265706f3a73656d637478000000117061636b616765732f64656d6f2e74787400000001000000020000000100000002000100000006616263313233000000204040202d312c32202b312c322040400a2d6f6c640a2b6e65770a206b6565700a",
  identity: createObservedDiffHunkV1(input).identity,
  expectedIdentity: "sha256:8e5c558849431b16e62d642bda29b2d82c26030eb6c9cc1bbed19bab37284562",
});
