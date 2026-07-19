import { describe, expect, test } from "bun:test";
import {
  launchSemctxMcp,
  semctxExecutableCandidates,
  type LauncherRuntime,
} from "../bin/semctx-mcp-launcher";

function runtime(overrides: Partial<LauncherRuntime> = {}): LauncherRuntime {
  return {
    platform: "linux",
    lookupGlobalBin: () => ({ success: true, path: "/opt/bun/bin\n", exitCode: 0 }),
    pathExists: () => true,
    spawn: async () => 0,
    writeError: () => undefined,
    ...overrides,
  };
}

describe("Claude semctx MCP launcher", () => {
  test("resolves platform-specific executable candidates", () => {
    expect(semctxExecutableCandidates("C:\\bun\\bin", "win32")).toEqual([
      "C:\\bun\\bin\\semctx-mcp.exe",
      "C:\\bun\\bin\\semctx-mcp.cmd",
      "C:\\bun\\bin\\semctx-mcp",
    ]);
    expect(semctxExecutableCandidates("/opt/bun/bin", "linux")).toEqual([
      "/opt/bun/bin/semctx-mcp",
    ]);
  });

  test("propagates the linked server exit code", async () => {
    let launched = "";
    const exitCode = await launchSemctxMcp(
      runtime({
        spawn: async (executable) => {
          launched = executable;
          return 23;
        },
      }),
    );

    expect(launched).toBe("/opt/bun/bin/semctx-mcp");
    expect(exitCode).toBe(23);
  });

  test("fails clearly when Bun global-bin lookup fails", async () => {
    let error = "";
    const exitCode = await launchSemctxMcp(
      runtime({
        lookupGlobalBin: () => ({ success: false, path: "", exitCode: 9 }),
        writeError: (message) => {
          error = message;
        },
      }),
    );

    expect(exitCode).toBe(9);
    expect(error).toContain("Unable to locate Bun's global bin directory");
  });

  test("fails with 127 when semctx-mcp is not linked", async () => {
    let error = "";
    const exitCode = await launchSemctxMcp(
      runtime({
        pathExists: () => false,
        writeError: (message) => {
          error = message;
        },
      }),
    );

    expect(exitCode).toBe(127);
    expect(error).toContain("semctx-mcp is not linked");
  });
});
