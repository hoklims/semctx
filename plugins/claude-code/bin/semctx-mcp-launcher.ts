#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";

export interface LauncherRuntime {
  platform: string;
  lookupGlobalBin: () => { success: boolean; path: string; exitCode: number };
  pathExists: (path: string) => boolean;
  spawn: (executable: string) => Promise<number>;
  writeError: (message: string) => void;
}

export function semctxExecutableCandidates(globalBin: string, platform: string): string[] {
  const path = platform === "win32" ? win32 : posix;
  const names = platform === "win32" ? ["semctx-mcp.exe", "semctx-mcp.cmd", "semctx-mcp"] : ["semctx-mcp"];
  return names.map((name) => path.join(globalBin, name));
}

export async function launchSemctxMcp(runtime: LauncherRuntime): Promise<number> {
  const binLookup = runtime.lookupGlobalBin();
  if (!binLookup.success) {
    runtime.writeError("Unable to locate Bun's global bin directory. Run `bun link` in packages/mcp-server.\n");
    return binLookup.exitCode || 1;
  }

  const globalBin = binLookup.path.trim();
  const executable = semctxExecutableCandidates(globalBin, runtime.platform).find(runtime.pathExists);
  if (!executable) {
    runtime.writeError(
      `semctx-mcp is not linked in ${globalBin}. Run \`bun link\` in packages/mcp-server.\n`,
    );
    return 127;
  }

  return runtime.spawn(executable);
}

if (import.meta.main) {
  const exitCode = await launchSemctxMcp({
    platform: process.platform,
    lookupGlobalBin: () => {
      const result = Bun.spawnSync([process.execPath, "pm", "bin", "-g"]);
      return {
        success: result.success,
        path: result.stdout.toString(),
        exitCode: result.exitCode,
      };
    },
    pathExists: existsSync,
    spawn: async (executable) => {
      const child = Bun.spawn([executable], {
        cwd: process.cwd(),
        env: process.env,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      return child.exited;
    },
    writeError: (message) => process.stderr.write(message),
  });

  process.exit(exitCode);
}
