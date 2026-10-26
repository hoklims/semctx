import { expect, test } from "bun:test";
import { retainedMetadataFromTs7 } from "./t00-ts7-q-boundary-paths";

test("metadata closure follows relative JSONC inheritance once and excludes bare and absent targets", () => {
  const available = ["/project/dist/tsconfig.json", "/project/dist/base.json", "/project/dist/leaf.json", "/project/dist/unused.json", "/project/package.json"];
  const references = [
    { path: available[0], extends: ["./base", "package-name", "./absent"] },
    { path: available[1], extends: ["./leaf.json"] },
    { path: available[2], extends: ["./base"] },
    { path: available[3], extends: [] },
    { path: available[4], extends: [] },
  ];
  expect(retainedMetadataFromTs7("/project", available, references)).toEqual(["dist/base.json", "dist/leaf.json", "dist/tsconfig.json", "package.json"]);
  expect(retainedMetadataFromTs7("/project", available, references.map(row => row.path === available[0] ? { ...row, extends: [] } : row))).toEqual(["dist/tsconfig.json", "package.json"]);
});

test("metadata closure rejects missing, foreign, duplicate and malformed AST observations", () => {
  for (const rows of [undefined, [], [{ path: "/foreign/tsconfig.json", extends: [] }], [{ path: "/project/tsconfig.json", extends: 7 }], [{ path: "/project/tsconfig.json", extends: [7] }], [{ path: "/project/tsconfig.json", extends: [] }, { path: "/project/tsconfig.json", extends: [] }]]) {
    expect(() => retainedMetadataFromTs7("/project", ["/project/tsconfig.json"], rows)).toThrow();
  }
});
