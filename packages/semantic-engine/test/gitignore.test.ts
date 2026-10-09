import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSemanticGitignore } from "../src/gitignore";

const repositories: string[] = [];

afterEach(() => {
  for (const root of repositories.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createRepository(): string {
  const root = mkdtempSync(join(tmpdir(), "semctx-gitignore-"));
  repositories.push(root);
  const result = spawnSync("git", ["init", "--quiet", root], { encoding: "utf8" });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  return root;
}

function expectIgnored(root: string, path: string, ignored: boolean): void {
  const result = spawnSync("git", ["-c", "core.excludesFile=", "check-ignore", "--no-index", "--quiet", "--", path], {
    cwd: root,
    encoding: "utf8",
  });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(ignored ? 0 : 1);
}

describe("semantic gitignore integration", () => {
  for (const projectOnly of [false, true]) {
    for (const [prefix, suffix] of [[" ", ""], ["\t", ""], ["", "\t"], ["", "\u00a0"]]) {
      it(`repairs literal whitespace in ${projectOnly ? "project" : "broad semantic"} rules (${JSON.stringify([prefix, suffix])})`, () => {
        const root = createRepository();
        const policy = [
          ".semctx/*",
          "!.semctx/semantic/",
          ...(projectOnly
            ? [".semctx/semantic/*", "!.semctx/semantic/project/", "!.semctx/semantic/project/**"]
            : ["!.semctx/semantic/**"]),
          "!.semctx/config.json",
        ];
        const original = `${policy.map((line) => `${prefix}${line}${suffix}`).join("\n")}\n`;
        writeFileSync(join(root, ".gitignore"), original);

        expect(ensureSemanticGitignore(root, true).action).toBe("update");
        expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(original);
        expect(ensureSemanticGitignore(root).action).toBe("update");

        expectIgnored(root, ".semctx/config.json", false);
        expectIgnored(root, ".semctx/semantic/project/domain.sem", false);
        expectIgnored(root, ".semctx/semantic/requirements.sem", projectOnly);
        expectIgnored(root, ".semctx/semctx.db", true);
        expectIgnored(root, ".semctx/working/change.json", true);
        const content = readFileSync(join(root, ".gitignore"), "utf8");
        expect(ensureSemanticGitignore(root).action).toBe("present");
        expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(content);
      });
    }
  }

  for (const broadLast of [true, false]) {
    it(`preserves the effective ${broadLast ? "broad semantic" : "project"} variant of mixed rules`, () => {
      const root = createRepository();
      const broad = "!.semctx/semantic/**";
      const project = [".semctx/semantic/*", "!.semctx/semantic/project/", "!.semctx/semantic/project/**"];
      const policy = [
        ".semctx/*",
        "!.semctx/semantic/",
        ...(broadLast ? [...project, broad] : [broad, ...project]),
        "!.semctx/config.json",
      ];
      writeFileSync(join(root, ".gitignore"), `${policy.join("\n")}\n`);
      expectIgnored(root, ".semctx/semantic/requirements.sem", !broadLast);

      expect(ensureSemanticGitignore(root).action).toBe("update");

      expectIgnored(root, ".semctx/config.json", false);
      expectIgnored(root, ".semctx/semantic/project/domain.sem", false);
      expectIgnored(root, ".semctx/semantic/requirements.sem", !broadLast);
      expectIgnored(root, ".semctx/semantic/nested/contracts.sem", !broadLast);
      expectIgnored(root, ".semctx/semctx.db", true);
      expectIgnored(root, ".semctx/working/change.json", true);
      const content = readFileSync(join(root, ".gitignore"), "utf8");
      expect(ensureSemanticGitignore(root).action).toBe("present");
      expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(content);
    });
  }

  for (const projectException of ["!.semctx/semantic/project/", "!.semctx/semantic/project/**"]) {
    it(`keeps a broad policy broad with the redundant ${projectException} exception`, () => {
      const root = createRepository();
      const policy = [".semctx/*", "!.semctx/semantic/", projectException, "!.semctx/config.json"];
      writeFileSync(join(root, ".gitignore"), `${policy.join("\n")}\n`);
      expectIgnored(root, ".semctx/semantic/requirements.sem", false);

      expect(ensureSemanticGitignore(root).action).toBe("update");

      expectIgnored(root, ".semctx/config.json", false);
      expectIgnored(root, ".semctx/semantic/project/domain.sem", false);
      expectIgnored(root, ".semctx/semantic/requirements.sem", false);
      expectIgnored(root, ".semctx/semantic/nested/contracts.sem", false);
      expectIgnored(root, ".semctx/semctx.db", true);
      const content = readFileSync(join(root, ".gitignore"), "utf8");
      expect(ensureSemanticGitignore(root).action).toBe("present");
      expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(content);
    });
  }

  for (const projectOnly of [false, true]) {
    for (const [prefix, suffix] of [[" ", ""], ["\t", ""], ["", "\t"], ["", "\u00a0"]]) {
      it(`preserves an effective ${projectOnly ? "project" : "broad"} policy despite an inactive contradictory rule (${JSON.stringify([prefix, suffix])})`, () => {
        const root = createRepository();
        const policy = [
          ".semctx/*",
          "!.semctx/semantic/",
          ...(projectOnly ? [".semctx/semantic/*", "!.semctx/semantic/project/", "!.semctx/semantic/project/**"] : []),
          "!.semctx/config.json",
          `${prefix}${projectOnly ? "!.semctx/semantic/**" : ".semctx/semantic/*"}${suffix}`,
        ];
        writeFileSync(join(root, ".gitignore"), `${policy.join("\n")}\n`);
        expectIgnored(root, ".semctx/semantic/requirements.sem", projectOnly);

        expect(ensureSemanticGitignore(root).action).toBe("update");

        expectIgnored(root, ".semctx/config.json", false);
        expectIgnored(root, ".semctx/semantic/project/domain.sem", false);
        expectIgnored(root, ".semctx/semantic/requirements.sem", projectOnly);
        expectIgnored(root, ".semctx/semantic/generated/model.json", projectOnly);
        expectIgnored(root, ".semctx/semctx.db", true);
        const content = readFileSync(join(root, ".gitignore"), "utf8");
        expect(ensureSemanticGitignore(root).action).toBe("present");
        expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(content);
      });
    }
  }

  for (const projectOnly of [false, true]) {
    it(`repairs duplicate config rules masking a missing ${projectOnly ? "project" : "broad semantic"} descendant exception`, () => {
      const root = createRepository();
      const rules = [
        "*.sem",
        ".semctx/*",
        "!.semctx/semantic/",
        ...(projectOnly ? [".semctx/semantic/*", "!.semctx/semantic/project/"] : []),
        "!.semctx/config.json",
        "!.semctx/config.json",
      ];
      writeFileSync(join(root, ".gitignore"), `${rules.join("\n")}\n`);

      const result = ensureSemanticGitignore(root);

      expectIgnored(root, ".semctx/config.json", false);
      expectIgnored(root, projectOnly ? ".semctx/semantic/project/domain.sem" : ".semctx/semantic/requirements.sem", false);
      expectIgnored(root, "user.sem", true);
      expectIgnored(root, ".semctx/working/change.sem", true);
      expect(result.action).toBe("update");
      const content = readFileSync(join(root, ".gitignore"), "utf8");
      expect(ensureSemanticGitignore(root).action).toBe("present");
      expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(content);
    });
  }

  for (const reversed of [true, false]) {
    it(`repairs ${reversed ? "reversed" : "canonical"} project rules followed by a foreign authored-source exclusion`, () => {
      const root = createRepository();
      const policy = [
        ".semctx/*",
        "!.semctx/semantic/",
        ".semctx/semantic/*",
        "!.semctx/semantic/project/",
        "!.semctx/semantic/project/**",
        "!.semctx/config.json",
      ];
      const foreign = ["node_modules/", "*.sem", "*.yaml", "!keep.sem"];
      const rules = reversed ? policy.toReversed() : policy;
      writeFileSync(join(root, ".gitignore"), `${rules.join("\n")}\n${foreign.join("\n")}\n`);

      const result = ensureSemanticGitignore(root);

      expectIgnored(root, ".semctx/semantic/project/domain.sem", false);
      expectIgnored(root, ".semctx/semantic/project/domain.yaml", false);
      expectIgnored(root, "user.sem", true);
      expectIgnored(root, "user.yaml", true);
      expectIgnored(root, "keep.sem", false);
      expect(result.action).toBe("update");
      const content = readFileSync(join(root, ".gitignore"), "utf8");
      expect(content.split("\n").filter((line) => foreign.includes(line))).toEqual(foreign);
      expect(ensureSemanticGitignore(root).action).toBe("present");
      expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(content);
    });
  }

  it("repairs a complete policy whose rule order hides authored sources", () => {
    const root = createRepository();
    writeFileSync(join(root, ".gitignore"), [
      "!.semctx/config.json",
      "!.semctx/semantic/project/**",
      "!.semctx/semantic/project/",
      ".semctx/semantic/*",
      "!.semctx/semantic/",
      ".semctx/*",
      "",
    ].join("\n"));

    const result = ensureSemanticGitignore(root);

    expectIgnored(root, ".semctx/config.json", false);
    expectIgnored(root, ".semctx/semantic/project/domains/checkout.yaml", false);
    expectIgnored(root, ".semctx/semctx.db", true);
    expectIgnored(root, ".semctx/working/change.json", true);
    expectIgnored(root, ".semctx/cache/context.json", true);
    expectIgnored(root, ".semctx/semantic/generated/model.json", true);
    expect(result.action).toBe("update");
  });

  for (const existing of [undefined, "node_modules/\n.semctx/\n", "node_modules/\n.semctx\n"]) {
    it(`preserves broad semantic tracking from ${existing === undefined ? "a missing file" : existing.trim().split("\n").at(-1)}`, () => {
      const root = createRepository();
      if (existing !== undefined) writeFileSync(join(root, ".gitignore"), existing);

      expect(ensureSemanticGitignore(root).action).toBe(existing === undefined ? "create" : "update");

      expectIgnored(root, ".semctx/config.json", false);
      expectIgnored(root, ".semctx/semantic/project/domains/checkout.yaml", false);
      expectIgnored(root, ".semctx/semantic/project/contracts/nested/payment.yaml", false);
      expectIgnored(root, ".semctx/semctx.db", true);
      expectIgnored(root, ".semctx/working/change.json", true);
      expectIgnored(root, ".semctx/cache/context.json", true);
      expectIgnored(root, ".semctx/semantic/requirements.sem", false);
      const content = readFileSync(join(root, ".gitignore"), "utf8");
      expect(ensureSemanticGitignore(root).action).toBe("present");
      expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(content);
    });
  }

  it("preserves foreign rules and their order while repairing duplicate Semctx rules", () => {
    const root = createRepository();
    const foreignBefore = "# User exclusions\r\nnode_modules/\r\n*.log\r\n!keep.log";
    const foreignAfter = "build/\r\n!build/keep/\r\n\\#literal-name";
    writeFileSync(join(root, ".gitignore"), `${foreignBefore}\r\n.semctx/\r\n!.semctx/config.json\r\n.semctx/*\r\n${foreignAfter}\r\n`);

    ensureSemanticGitignore(root);

    const content = readFileSync(join(root, ".gitignore"), "utf8");
    const foreignLines = content.split(/\r?\n/).filter((line) => !line.includes(".semctx") && line.length > 0);
    expect(foreignLines).toEqual(`${foreignBefore}\r\n${foreignAfter}`.split("\r\n"));
    expectIgnored(root, "node_modules/package/index.js", true);
    expectIgnored(root, "debug.log", true);
    expectIgnored(root, "keep.log", false);
    expectIgnored(root, "build/output.js", true);
    expectIgnored(root, ".semctx/config.json", false);
    expectIgnored(root, ".semctx/semantic/project/domain.yaml", false);
    expectIgnored(root, ".semctx/working/state.json", true);
    expect(ensureSemanticGitignore(root).action).toBe("present");
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(content);
  });

  it("repairs reversed broad semantic rules without narrowing authored sources", () => {
    const root = createRepository();
    writeFileSync(join(root, ".gitignore"), "!.semctx/config.json\n!.semctx/semantic/\n.semctx/*\n");

    expect(ensureSemanticGitignore(root).action).toBe("update");

    expectIgnored(root, ".semctx/config.json", false);
    expectIgnored(root, ".semctx/semantic/requirements.sem", false);
    expectIgnored(root, ".semctx/semantic/nested/contracts.sem", false);
    expectIgnored(root, ".semctx/semctx.db", true);
    expectIgnored(root, ".semctx/working/change.json", true);
    expectIgnored(root, ".semctx/cache/context.json", true);
    const content = readFileSync(join(root, ".gitignore"), "utf8");
    expect(ensureSemanticGitignore(root).action).toBe("present");
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(content);
  });

  it("keeps broad authored semantic sources versionable despite a trailing foreign exclusion", () => {
    const root = createRepository();
    writeFileSync(join(root, ".gitignore"), ".semctx/*\n!.semctx/semantic/\n!.semctx/config.json\n*.sem\n");

    ensureSemanticGitignore(root);

    expectIgnored(root, ".semctx/semantic/requirements.sem", false);
    expectIgnored(root, ".semctx/semantic/nested/contracts.sem", false);
    expectIgnored(root, "user.sem", true);
    expectIgnored(root, ".semctx/working/change.sem", true);
    expect(readFileSync(join(root, ".gitignore"), "utf8").split("\n").filter((line) => line === "*.sem")).toEqual(["*.sem"]);
  });

  it("reports creation in dry-run without creating the missing file", () => {
    const root = createRepository();

    expect(ensureSemanticGitignore(root, true)).toEqual({ path: ".gitignore", action: "create" });
    expect(existsSync(join(root, ".gitignore"))).toBe(false);
  });

  it("reports repair in dry-run without modifying existing bytes", () => {
    const root = createRepository();
    const original = "node_modules/\r\n.semctx/\r\n";
    writeFileSync(join(root, ".gitignore"), original);

    expect(ensureSemanticGitignore(root, true)).toEqual({ path: ".gitignore", action: "update" });
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(original);
    expectIgnored(root, ".semctx/config.json", true);
  });
});
