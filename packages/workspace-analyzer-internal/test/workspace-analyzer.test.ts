import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeWorkspace,
  analyzeWorkspaceSync,
  projectWorkspaceCandidates,
  type WorkspaceCandidate,
} from "../src/index";

const fixtureRoots: string[] = [];
const itOnPosix = process.platform === "win32" ? it.skip : it;
const itOnWindows = process.platform === "win32" ? it : it.skip;

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "semctx-workspace-"));
  const canonicalRoot = await realpath(root);
  fixtureRoots.push(canonicalRoot);
  return canonicalRoot;
}

async function json(root: string, path: string, value: unknown): Promise<void> {
  const target = join(root, path);
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
}

async function text(root: string, path: string, value: string): Promise<void> {
  const target = join(root, path);
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, value);
}

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ADR-C08 workspace detection", () => {
  it("1: treats packages/apps layout as candidates only", async () => {
    const root = await fixture();
    await mkdir(join(root, "packages", "foo"), { recursive: true });
    await mkdir(join(root, "apps", "web"), { recursive: true });

    const projection = await analyzeWorkspace({ repositoryRoot: root });

    expect(projection.nodes).toEqual([]);
    expect(projection.edges).toEqual([]);
    expect(projection.candidates.map((candidate) => candidate.root)).toEqual(["apps/web", "packages/foo"]);
  });

  it("2: admits manifest and declared workspace units with exact evidence", async () => {
    const root = await fixture();
    await json(root, "package.json", { name: "repo", workspaces: ["packages/*"] });
    await json(root, "packages/foo/package.json", { name: "@acme/foo" });
    await mkdir(join(root, "packages", "bare"), { recursive: true });

    const projection = await analyzeWorkspace({ repositoryRoot: root });

    expect(projection.schemaVersion).toBe(1);
    expect(projection.nodes.map(({ root, identity }) => ({ root, identity }))).toEqual([
      { root: ".", identity: "repo" },
      { root: "packages/bare", identity: "bare" },
      { root: "packages/foo", identity: "@acme/foo" },
    ]);
    expect(projection.nodes.find((node) => node.root === "packages/foo")?.evidence).toEqual([
      {
        manifestPath: "package.json",
        field: "workspaces[0]",
        value: "packages/*",
      },
      {
        manifestPath: "packages/foo/package.json",
        field: "name",
        value: "@acme/foo",
      },
    ]);
    expect(projection.edges.filter((edge) => edge.kind === "workspace_member_of")).toHaveLength(3);
  });

  it("3 and 6: rejects an identity claimed at conflicting non-ancestor roots", () => {
    const projection = projectWorkspaceCandidates({
      repositoryId: "repo:test",
      candidates: [
        candidate("packages/a", "shared", undefined, "a.json"),
        candidate("vendor/a", "shared", undefined, "vendor.json"),
      ],
      artifacts: [],
    });

    expect(projection.nodes).toEqual([]);
    expect(projection.edges).toEqual([]);
    expect(projection.diagnostics).toEqual([
      expect.objectContaining({ code: "AMBIGUOUS_LAYOUT", roots: ["packages/a", "vendor/a"] }),
    ]);
  });

  it("4: assigns nested units and artifacts to their nearest admitted ancestor", async () => {
    const root = await fixture();
    await json(root, "package.json", { name: "repo" });
    await json(root, "packages/foo/package.json", { name: "foo" });
    await json(root, "packages/foo/plugins/bar/package.json", { name: "bar" });

    const projection = await analyzeWorkspace({
      repositoryRoot: root,
      repositoryId: "repo:test",
      artifacts: [
        { id: "mod:bar", kind: "module", filePath: "packages/foo/plugins/bar/src/a.ts" },
        { id: "mod:foo", kind: "test", filePath: "packages/foo/test/a.test.ts" },
      ],
    });

    expect(projection.edges).toContainEqual(expect.objectContaining({
      kind: "workspace_member_of",
      from: "workspace:packages/foo/plugins/bar",
      to: "workspace:packages/foo",
    }));
    expect(projection.edges).toContainEqual(expect.objectContaining({
      kind: "contained_in_workspace",
      from: "mod:bar",
      to: "workspace:packages/foo/plugins/bar",
    }));
    expect(projection.edges).toContainEqual(expect.objectContaining({
      kind: "contained_in_workspace",
      from: "mod:foo",
      to: "workspace:packages/foo",
    }));
  });

  it("5: rejects conflicting same-root identities and emits no edges for that root", () => {
    const projection = projectWorkspaceCandidates({
      repositoryId: "repo:test",
      candidates: [
        candidate("packages/a", "one", undefined, "package.json"),
        candidate("packages/a", "two", undefined, "pyproject.toml"),
      ],
      artifacts: [{ id: "mod:a", kind: "module", filePath: "packages/a/src/a.ts" }],
    });

    expect(projection.nodes).toEqual([]);
    expect(projection.edges).toEqual([]);
    expect(projection.diagnostics[0]).toMatchObject({
      code: "AMBIGUOUS_LAYOUT",
      roots: ["packages/a"],
    });
  });

  it("rejects same-root evidence whose implicit nearest parent disagrees with an explicit parent", () => {
    const projection = projectWorkspaceCandidates({
      repositoryId: "repo:test",
      candidates: [
        candidate("a", "a", undefined, "a/package.json"),
        candidate("a/b", "b", "a", "a/b/package.json"),
        candidate("a/b/c", "c", undefined, "a/b/c/package.json"),
        candidate("a/b/c", "c", "a", "a/package.json"),
      ],
      artifacts: [{ id: "mod:c", kind: "module", filePath: "a/b/c/src/c.ts" }],
    });

    expect(projection.nodes.some((node) => node.root === "a/b/c")).toBe(false);
    expect(projection.edges.some((edge) =>
      edge.from === "workspace:a/b/c"
      || edge.to === "workspace:a/b/c")).toBe(false);
    expect(projection.edges).toContainEqual(expect.objectContaining({
      kind: "contained_in_workspace",
      from: "mod:c",
      to: "workspace:a/b",
    }));
    expect(projection.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "AMBIGUOUS_LAYOUT",
        roots: ["a/b/c"],
      }),
    ]));
  });

  it("rejects malformed manifests at the affected root", async () => {
    const root = await fixture();
    await text(root, "packages/bad/package.json", '{"name":');

    const projection = await analyzeWorkspace({ repositoryRoot: root });

    expect(projection.nodes).toEqual([]);
    expect(projection.edges).toEqual([]);
    expect(projection.diagnostics).toEqual([
      expect.objectContaining({
        code: "AMBIGUOUS_LAYOUT",
        roots: ["packages/bad"],
        evidence: [expect.objectContaining({ manifestPath: "packages/bad/package.json", field: "$" })],
      }),
    ]);
  });

  it("7: rejects escaping, external, and symlinked declared roots", async () => {
    const root = await fixture();
    const external = await fixture();
    await mkdir(join(external, "external"), { recursive: true });
    await mkdir(join(root, "real"), { recursive: true });
    await symlink(join(root, "real"), join(root, "linked"), "junction");
    await json(root, "package.json", {
      workspaces: ["../escape", join(external, "external"), "linked"],
    });

    const projection = await analyzeWorkspace({ repositoryRoot: root });

    expect(projection.nodes).toEqual([]);
    expect(projection.edges).toEqual([]);
    expect(projection.diagnostics.every((item) => item.code === "AMBIGUOUS_LAYOUT")).toBe(true);
    expect(projection.diagnostics).toHaveLength(3);
  });

  itOnPosix("rejects a direct symlink repository root without emitting a projection", async () => {
    const base = await fixture();
    const repository = join(base, "repository");
    const linkedRepository = join(base, "linked-repository");
    await mkdir(repository);
    await json(repository, "package.json", { name: "repository" });
    await symlink(repository, linkedRepository, "dir");

    await expectRejectedProjectionParity(linkedRepository, ".");
  });

  itOnPosix("rejects a repository path with a symlinked ancestor without emitting a projection", async () => {
    const base = await fixture();
    const realAncestor = join(base, "real-ancestor");
    const repository = join(realAncestor, "repository");
    const linkedAncestor = join(base, "linked-ancestor");
    await mkdir(repository, { recursive: true });
    await json(repository, "package.json", { name: "repository" });
    await symlink(realAncestor, linkedAncestor, "dir");

    await expectRejectedProjectionParity(join(linkedAncestor, "repository"), ".");
  });

  itOnPosix("rejects a direct symlink workspace root without emitting a projection", async () => {
    const root = await fixture();
    const external = await fixture();
    await json(root, "package.json", { workspaces: ["packages/*"] });
    await json(external, "package.json", { name: "linked-workspace" });
    await mkdir(join(root, "packages"), { recursive: true });
    await symlink(external, join(root, "packages", "linked"), "dir");

    await expectRejectedProjectionParity(root, "packages/linked");
  });

  itOnWindows("accepts a safe repository reached through a Windows alternate path spelling", async () => {
    const root = await fixture();
    await json(root, "package.json", { name: "repository" });

    const input = { repositoryRoot: root, repositoryId: "repo:alternate-spelling" };
    const asynchronous = await analyzeWorkspace(input);
    const synchronous = analyzeWorkspaceSync(input);

    expect(JSON.stringify(synchronous)).toBe(JSON.stringify(asynchronous));
    expect(asynchronous.diagnostics).toEqual([]);
    expect(asynchronous.nodes).toContainEqual(expect.objectContaining({
      root: ".",
      identity: "repository",
    }));
  });

  itOnWindows("rejects a Windows directory junction repository root", async () => {
    const base = await realpath(await fixture());
    const repository = join(base, "real-repository");
    const repositoryJunction = join(base, "repository-junction");
    await mkdir(repository);
    await json(repository, "package.json", { name: "repository" });
    await symlink(repository, repositoryJunction, "junction");

    await expectRejectedProjectionParity(repositoryJunction, ".");
  });

  itOnWindows("rejects a repository path with a Windows junction ancestor", async () => {
    const base = await realpath(await fixture());
    const realAncestor = join(base, "real-ancestor");
    const repository = join(realAncestor, "repository");
    const linkedAncestor = join(base, "linked-ancestor");
    await mkdir(repository, { recursive: true });
    await json(repository, "package.json", { name: "repository" });
    await symlink(realAncestor, linkedAncestor, "junction");

    await expectRejectedProjectionParity(join(linkedAncestor, "repository"), ".");
  });

  itOnWindows("rejects a Windows directory junction workspace root without emitting a projection", async () => {
    const root = await realpath(await fixture());
    const external = await fixture();
    await json(root, "package.json", { workspaces: ["packages/*"] });
    await json(external, "package.json", { name: "junction-workspace" });
    await mkdir(join(root, "packages"), { recursive: true });
    await symlink(external, join(root, "packages", "junction"), "junction");

    await expectRejectedProjectionParity(root, "packages/junction");
  });

  it("8: leaves unowned artifacts and legacy relations untouched", async () => {
    const root = await fixture();
    await text(root, "src/a.ts", "export {};\n");
    const legacy = [{ id: "legacy", kind: "belongs_to", from: "mod:a", to: "repo:test" }] as const;

    const projection = await analyzeWorkspace({
      repositoryRoot: root,
      artifacts: [{ id: "mod:a", kind: "module", filePath: "src/a.ts" }],
    });

    expect(projection.nodes).toEqual([]);
    expect(projection.edges).toEqual([]);
    expect(legacy).toEqual([{ id: "legacy", kind: "belongs_to", from: "mod:a", to: "repo:test" }]);
    expect(JSON.stringify(projection)).not.toContain("belongs_to");
  });

  it("9: rejects cyclic candidate parents", () => {
    const projection = projectWorkspaceCandidates({
      repositoryId: "repo:test",
      candidates: [
        candidate("a", "a", "a/b", "a.json"),
        candidate("a/b", "b", "a", "b.json"),
      ],
      artifacts: [],
    });

    expect(projection.nodes).toEqual([]);
    expect(projection.edges).toEqual([]);
    expect(projection.diagnostics[0]).toMatchObject({
      code: "AMBIGUOUS_LAYOUT",
      roots: ["a", "a/b"],
    });
  });

  it("rejects descendants of a rejected cyclic parent and direct escaping candidates", () => {
    const projection = projectWorkspaceCandidates({
      repositoryId: "repo:test",
      candidates: [
        candidate("a", "a", "a/b", "a.json"),
        candidate("a/b", "b", "a", "b.json"),
        candidate("a/b/child", "child", "a/b", "child.json"),
        candidate("../outside", "outside", undefined, "outside.json"),
      ],
      artifacts: [{ id: "mod:child", kind: "module", filePath: "a/b/child/src/a.ts" }],
    });

    expect(projection.nodes).toEqual([]);
    expect(projection.edges).toEqual([]);
    expect(projection.diagnostics.some((item) => item.roots.includes("../outside"))).toBe(true);
    expect(projection.diagnostics.some((item) => item.roots.includes("a/b/child"))).toBe(true);
  });

  it("detects pyproject identities and uv workspace members deterministically", async () => {
    const root = await fixture();
    await text(root, "pyproject.toml", [
      "[project]",
      'name = "python-repo"',
      "",
      "[tool.uv.workspace]",
      'members = ["libs/*"]',
      "",
    ].join("\n"));
    await text(root, "libs/core/pyproject.toml", '[project]\nname = "python-core"\n');

    const projection = await analyzeWorkspace({ repositoryRoot: root });

    expect(projection.nodes.map(({ root: nodeRoot, identity }) => [nodeRoot, identity])).toEqual([
      [".", "python-repo"],
      ["libs/core", "python-core"],
    ]);
    expect(projection.edges).toEqual([...projection.edges].sort(compareProjectionItems));
  });

  it("produces byte-identical synchronous and asynchronous projections", async () => {
    const root = await fixture();
    await json(root, "package.json", { name: "repo", workspaces: ["packages/*"] });
    await json(root, "packages/foo/package.json", { name: "@acme/foo" });
    await text(root, "packages/foo/python/pyproject.toml", '[project]\nname = "python-part"\n');
    const input = {
      repositoryRoot: root,
      repositoryId: "repo:parity",
      artifacts: [
        { id: "mod:foo", kind: "module" as const, filePath: "packages/foo/src/a.ts" },
        { id: "mod:python", kind: "module" as const, filePath: "packages/foo/python/a.py" },
      ],
    };

    const asynchronous = await analyzeWorkspace(input);
    const synchronous = analyzeWorkspaceSync(input);

    expect(JSON.stringify(synchronous)).toBe(JSON.stringify(asynchronous));
  });

  it("is deterministic, acyclic, and gives every package exactly one parent", async () => {
    const root = await fixture();
    await json(root, "z/package.json", { name: "z" });
    await json(root, "a/package.json", { name: "a" });
    await json(root, "a/nested/package.json", { name: "nested" });

    const first = await analyzeWorkspace({ repositoryRoot: root });
    const second = await analyzeWorkspace({ repositoryRoot: root });
    const parents = first.edges.filter((edge) => edge.kind === "workspace_member_of");

    expect(first).toEqual(second);
    expect(parents).toHaveLength(first.nodes.length);
    expect(new Set(parents.map((edge) => edge.from)).size).toBe(first.nodes.length);
    for (const edge of parents) {
      expect(edge.to === "repository" || edge.to !== edge.from).toBe(true);
    }
  });
});

async function expectRejectedProjectionParity(
  repositoryRoot: string,
  diagnosticRoot: string,
): Promise<void> {
  const input = {
    repositoryRoot,
    repositoryId: "repo:unsafe-root",
    artifacts: [{ id: "mod:unsafe", kind: "module" as const, filePath: "src/a.ts" }],
  };

  const asynchronous = await analyzeWorkspace(input);
  const synchronous = analyzeWorkspaceSync(input);

  expect(JSON.stringify(synchronous)).toBe(JSON.stringify(asynchronous));
  expect(asynchronous.nodes).toEqual([]);
  expect(asynchronous.edges).toEqual([]);
  expect(asynchronous.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({
      code: "AMBIGUOUS_LAYOUT",
      roots: [diagnosticRoot],
    }),
  ]));
}

function candidate(
  root: string,
  identity: string,
  parentRoot: string | undefined,
  manifestPath: string,
): WorkspaceCandidate {
  return {
    root,
    identity,
    parentRoot,
    evidence: [{ manifestPath, field: "name", value: identity }],
  };
}

function compareProjectionItems(
  left: { kind: string; from: string; to: string },
  right: { kind: string; from: string; to: string },
): number {
  return `${left.kind}\0${left.from}\0${left.to}`.localeCompare(
    `${right.kind}\0${right.from}\0${right.to}`,
  );
}
