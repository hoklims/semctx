import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { changeFilePath } from "@semantic-context/semantic-engine";

describe("change file path containment", () => {
  const root = join("C:\\", "repo");

  for (const id of ["change.x/../../../evil", "change.x\\..\\..\\evil", "change.C:\\evil"]) {
    it(`rejects unsafe prefixed id: ${id}`, () => {
      expect(() => changeFilePath(root, id)).toThrow();
    });
  }
});
