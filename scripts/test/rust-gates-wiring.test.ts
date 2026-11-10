import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Step = { name?: string; uses?: string; run?: string; if?: string; "continue-on-error"?: boolean; with?: Record<string, unknown>; env?: Record<string, string> };
type Job = { needs?: string | string[]; if?: string; "continue-on-error"?: boolean; "timeout-minutes"?: number | string; steps?: Step[]; strategy?: { matrix?: { os?: string[] } }; env?: Record<string, string>; defaults?: { run?: { shell?: string } } };
type Workflow = { jobs: Record<string, Job> };

const source = readFileSync(join(import.meta.dir, "../../.github/workflows/ci.yml"), "utf8");
const experimentalManifests = [
  "tools/rust-ts-r0-ts7-experimental/Cargo.toml",
  "tools/t00-ts7-oracle-emit-helpers/Cargo.toml",
  "tools/t00-ts7-oracle-q-semantic/Cargo.toml",
  "tools/t00-ts7-oracle-q-syntax/Cargo.toml",
];
const nativeCommand = (operation: string, manifest: string): string =>
  `cargo ${operation} --manifest-path ${manifest}${operation === "fmt" ? " --check" : operation === "clippy" ? " --locked --all-targets -- -D warnings" : " --locked"}${operation === "test" && manifest === "tools/rust-ts-r0-ts7-experimental/Cargo.toml" ? " --release" + producerControls : ""}`;
const producerControls = [
  "env.GOPORT_LIB_PARSE_SNAPSHOT.value='0'",
  "env.GOPORT_LIB_PARSE_SNAPSHOT.force=true",
  "env.GOPORT_LIB_SNAPSHOT.value='0'",
  "env.GOPORT_LIB_SNAPSHOT.force=true",
  "env.RUST_TEST_THREADS.value='1'",
  "env.RUST_TEST_THREADS.force=true",
].map(config => ` --config "${config}"`).join("");
const commands = (job: Job): string => (job.steps ?? []).map(step => (step.run ?? "")
  .split("\n").filter(line => !line.trimStart().startsWith("#")).join("\n")).join("\n");

function wiringProblems(text: string): string[] {
  const { jobs } = Bun.YAML.parse(text) as Workflow;
  const problems: string[] = [];
  const plan = jobs.plan ?? {};
  const gates = jobs.gates ?? {};
  const native = jobs["rust-gates"] ?? {};
  const required = jobs["semctx-required"] ?? {};
  const normalized = (run: string | undefined): string[] => (run ?? "").split("\n")
    .map(line => line.trim()).filter(line => line !== "" && !line.startsWith("#"));
  const enforceStep = (job: Job, name: string, expected: string[], firstLineOnly = false): void => {
    const steps = (job.steps ?? []).filter(step => step.name === name);
    if (steps.length !== 1) { problems.push(`${name}: exactly one executable step is required`); return; }
    const step = steps[0]!;
    if (step.if !== undefined || (step["continue-on-error"] !== undefined && step["continue-on-error"] !== false)) problems.push(`${name}: conditional execution or ignored failure`);
    if (step.env?.GATE_BIN !== undefined || step.env?.QUALIFICATION_BIN !== undefined) problems.push(`${name}: verifier executable override`);
    const actual = normalized(step.run);
    if (JSON.stringify(firstLineOnly ? actual.slice(0, 1) : actual) !== JSON.stringify(expected)) problems.push(`${name}: expected invocation is not executed`);
  };
  for (const [name, job] of Object.entries({ plan, gates, native })) {
    if (job.if !== undefined) problems.push(`${name}: producer may be skipped`);
    if (job.defaults?.run?.shell !== undefined && job.defaults.run.shell !== "bash") problems.push(`${name}: shell failure semantics changed`);
  }
  enforceStep(plan, "Select required verification lanes", ['tools/gates/target/release/semctx-gates ci-plan --root "$GITHUB_WORKSPACE" --base "$SEMCTX_VERIFY_BASE" --head "$SEMCTX_VERIFY_HEAD" --output "$SEMCTX_PLAN_PATH"'], true);
  enforceStep(gates, "Run selected verification lane", ['"$GATE_BIN" ci-run --root "$GITHUB_WORKSPACE" --plan "$RUNNER_TEMP/plan/gate-plan.json" --lane "$SEMCTX_LANE_INDEX" --receipt "$SEMCTX_RECEIPT"']);
  enforceStep(native, "Execute native Rust tests", [
    "cargo test --manifest-path tools/gates/Cargo.toml --locked",
    "cargo test --manifest-path tools/qualification/Cargo.toml --locked",
    ...experimentalManifests.map(manifest => nativeCommand("test", manifest)),
  ]);
  enforceStep(native, "Check Rust formatting and lints", [
    ...["fmt", "clippy"].flatMap(operation =>
      ["tools/gates/Cargo.toml", "tools/qualification/Cargo.toml", "tools/rust-ts-r0/Cargo.toml", ...experimentalManifests]
        .map(manifest => nativeCommand(operation, manifest))),
  ]);
  enforceStep(native, "Discover and execute native product workspaces", ['cargo run --manifest-path tools/gates/Cargo.toml --locked -- rust-test --root "$GITHUB_WORKSPACE" > "$RUNNER_TEMP/native-product-tests.json"']);
  enforceStep(native, "Qualify the actual CLI and MCP artifacts", ['"$QUALIFICATION_BIN" --cli "$GITHUB_WORKSPACE/apps/cli/dist/index.js" --mcp "$GITHUB_WORKSPACE/plugins/semctx-control/dist/semctx-mcp.js" --runtime "$(bun -p process.execPath)" --out "$RUNNER_TEMP/qualification" --plan "$RUNNER_TEMP/plan/gate-plan.json" --os "$SEMCTX_QUALIFICATION_OS"']);
  enforceStep(required, "Verify all planned lane receipts", ['tools/gates/target/release/semctx-gates aggregate --root "$GITHUB_WORKSPACE" --plan "$RUNNER_TEMP/plan/gate-plan.json" --receipts "$RUNNER_TEMP/receipts"']);
  enforceStep(required, "Verify all native qualification reports", ['tools/qualification/target/release/semctx-qualification verify --reports "$RUNNER_TEMP/qualifications" --plan "$RUNNER_TEMP/plan/gate-plan.json" --cli "$GITHUB_WORKSPACE/apps/cli/dist/index.js" --mcp "$GITHUB_WORKSPACE/plugins/semctx-control/dist/semctx-mcp.js"']);
  if (gates.env?.GATE_BIN !== "tools/gates/target/release/semctx-gates${{ matrix.os == 'windows-latest' && '.exe' || '' }}") problems.push("gate executable identity changed or unsupported job env context");
  if (native.env?.QUALIFICATION_BIN !== "tools/qualification/target/release/semctx-qualification${{ matrix.os == 'windows-latest' && '.exe' || '' }}") problems.push("qualification executable identity changed or unsupported job env context");
  if (!commands(plan).includes("ci-plan --root")) problems.push("Rust planner is missing");
  if (!commands(gates).includes("ci-run --root")) problems.push("Rust executor is missing");
  if (gates.needs !== "plan" || native.needs !== "plan") problems.push("producers must consume the plan");
  const dependencies = Array.isArray(required.needs) ? [...required.needs].sort() : [];
  if (JSON.stringify(dependencies) !== JSON.stringify(["gates", "plan", "rust-gates"])) problems.push("required producers are incomplete");
  if (required.if !== "always()") problems.push("aggregate must run after failures");
  for (const field of ["PLAN_RESULT", "GATES_RESULT", "RUST_RESULT"]) {
    if (!commands(required).includes(`test "$${field}" = "success"`)) problems.push(`missing strict ${field}`);
  }
  if (!commands(required).includes("aggregate --root")) problems.push("receipt aggregation is missing");
  if (!commands(required).includes("semctx-qualification verify --reports")) problems.push("qualification admission is missing");
  if (JSON.stringify([...(native.strategy?.matrix?.os ?? [])].sort()) !== JSON.stringify(["macos-15", "ubuntu-latest", "windows-latest"])) problems.push("native OS coverage is incomplete");
  if (native["timeout-minutes"] !== "${{ matrix.os == 'windows-latest' && 60 || 20 }}") problems.push("native timeout must reserve 60 minutes for Windows and preserve 20 on Linux/macOS");
  const milestone = (native.steps ?? []).filter(step => step.name === "Acquire the ordered T00 Windows milestone");
  const milestoneGuard = "matrix.os == 'windows-latest' && github.event.pull_request.number == 386 && vars.T00_NATIVE_CANDIDATE_SHA == github.event.pull_request.head.sha";
  if (milestone.length !== 1 || milestone[0]?.if !== milestoneGuard
    || (commands(native).match(/python tools\/rust-ts-r0\/qualification\/run_windows_milestone\.py/g) ?? []).length !== 1) {
    problems.push("Windows milestone must remain unique and bound to the authorized candidate");
  }
  const nativeSteps = native.steps ?? [];
  const install = nativeSteps.findIndex(step => normalized(step.run).includes("bun install --frozen-lockfile"));
  const nativeTests = nativeSteps.findIndex(step => step.name === "Execute native Rust tests");
  if (install === -1 || nativeTests === -1 || install > nativeTests) problems.push("native Rust tests run before the JavaScript workspace is installed");
  const nativeCommands = commands(native);
  if (!nativeCommands.includes("rust-test --root")) problems.push("new native product crates may escape testing");
  for (const crate of ["gates", "qualification"]) {
    if (!nativeCommands.includes(`cargo test --manifest-path tools/${crate}/Cargo.toml --locked`)) problems.push(`native ${crate} tests are missing`);
  }
  if (nativeCommands.includes("--no-run")) problems.push("compilation is not test execution");
  if (!nativeCommands.includes("--cli") || !nativeCommands.includes("--mcp") || !nativeCommands.includes("--plan") || !nativeCommands.includes("--os")) problems.push("artifact qualification inputs are incomplete");
  for (const [name, job] of Object.entries({ gates, native, required })) {
    if (job["continue-on-error"] || job.steps?.some(step => step["continue-on-error"])) problems.push(`${name} may ignore failure`);
  }
  const gateUpload = gates.steps?.find(step => step.uses?.startsWith("actions/upload-artifact@") && String(step.with?.name).startsWith("rust-gate-receipt-"));
  if (gateUpload?.if !== "always()" || gateUpload.with?.["if-no-files-found"] !== "error") problems.push("receipt retention can silently disappear");
  return problems;
}

describe("Rust gate invocation and admission", () => {
  test("requires release only for experimental producer tests", () => {
    for (const manifest of experimentalManifests) {
      const command = nativeCommand("test", manifest);
      const wrongProfile = command.includes(" --release")
        ? command.replace(" --release", "") : `${command} --release`;
      expect(source.includes(command), `missing required profile: ${manifest}`).toBe(true);
      expect(wiringProblems(source.replace(command, wrongProfile)))
        .toContain("Execute native Rust tests: expected invocation is not executed");
    }
  });
  test("requires forced live SDK and serial controls only for the producer test route", () => {
    for (const config of [
      "env.GOPORT_LIB_PARSE_SNAPSHOT.value='0'",
  "env.GOPORT_LIB_PARSE_SNAPSHOT.force=true",
      "env.GOPORT_LIB_SNAPSHOT.value='0'",
  "env.GOPORT_LIB_SNAPSHOT.force=true",
      "env.RUST_TEST_THREADS.value='1'",
  "env.RUST_TEST_THREADS.force=true",
    ]) {
      const argument = ` --config "${config}"`;
      expect(source.includes(argument), `missing producer control: ${config}`).toBe(true);
      const wrongValue = config.includes(".force=")
        ? argument.replace("=true", "=false") : argument.replace(/='[01]'/, "='9'");
      for (const replacement of ["", wrongValue]) {
        expect(wiringProblems(source.replace(argument, replacement)))
          .toContain("Execute native Rust tests: expected invocation is not executed");
      }
    }
  });
  test("rejects every omitted, duplicated or ignored experimental tooling route", () => {
    for (const manifest of experimentalManifests) {
      for (const operation of ["fmt", "clippy", "test"]) {
        const command = nativeCommand(operation, manifest);
        expect(source.includes(command), `missing ${operation} route: ${manifest}`).toBe(true);
        for (const replacement of ["true", `${command}\n          ${command}`, `${command} || true`]) {
          expect(wiringProblems(source.replace(command, replacement)).length, command).toBeGreaterThan(0);
        }
      }
    }
  });
  test("requires native execution, exact receipt admission and all three operating systems", () => {
    expect(wiringProblems(source)).toEqual([]);
  });

  test("rejects omissions and compile-only substitutions in the real workflow", () => {
    const replacements: [string, string][] = [
      ["needs: [plan, gates, rust-gates]", "needs: [plan, gates]"],
      ["aggregate --root", "aggregate-disabled --root"],
      ["semctx-qualification verify --reports", "semctx-qualification report-only --reports"],
      ['test "$RUST_RESULT" = "success"', "true"],
      ["name: semctx-required\n    if: always()", "name: semctx-required\n    if: success()"],
      ["cargo test --manifest-path tools/gates/Cargo.toml --locked", "cargo test --manifest-path tools/gates/Cargo.toml --locked --no-run"],
      ["[ubuntu-latest, windows-latest, macos-15]", "[ubuntu-latest, windows-latest]"],
      ["ci-run --root", "ci-run-disabled --root"],
      ["rust-test --root", "rust-test-disabled --root"],
    ];
    for (const [before, after] of replacements) {
      expect(source.includes(before), `mutant requires an actual enforcement target: ${before}`).toBe(true);
      expect(wiringProblems(source.replace(before, after)).length, before).toBeGreaterThan(0);
    }
  });

  test("rejects native Rust tests that run before the JavaScript workspace is installed", () => {
    const install = "      - run: bun install --frozen-lockfile\n";
    const tests = "      - name: Execute native Rust tests\n";
    expect(source.includes(install + tests)).toBe(true);
    const late = source.replace(install + tests, tests).replace("      - name: Discover and execute native product workspaces\n", install + "      - name: Discover and execute native product workspaces\n");
    expect(late).not.toBe(source);
    expect(wiringProblems(late)).toContain("native Rust tests run before the JavaScript workspace is installed");
    expect(wiringProblems(source.replace(install + tests, tests))).toContain("native Rust tests run before the JavaScript workspace is installed");
  });

  test("rejects a disabled or inert native qualification verifier", () => {
    const disabled = source.replace("- name: Verify all native qualification reports\n", "- name: Verify all native qualification reports\n        if: false\n");
    expect(disabled).not.toBe(source);
    expect(wiringProblems(disabled).length).toBeGreaterThan(0);
    const inert = source.replace("run: tools/qualification/target/release/semctx-qualification verify --reports", "run: echo tools/qualification/target/release/semctx-qualification verify --reports");
    expect(inert).not.toBe(source);
    expect(wiringProblems(inert).length).toBeGreaterThan(0);
  });

  test("rejects an insufficient Windows budget or an extension to every native OS", () => {
    const timeout = "timeout-minutes: ${{ matrix.os == 'windows-latest' && 60 || 20 }}";
    expect(source.includes(timeout)).toBe(true);
    for (const replacement of ["timeout-minutes: 20", "timeout-minutes: 60", "timeout-minutes: ${{ matrix.os == 'ubuntu-latest' && 60 || 20 }}"]) {
      expect(wiringProblems(source.replace(timeout, replacement))).toContain("native timeout must reserve 60 minutes for Windows and preserve 20 on Linux/macOS");
    }
  });

  test("rejects removing the unique Windows milestone candidate guard", () => {
    const guard = "if: matrix.os == 'windows-latest' && github.event.pull_request.number == 386 && vars.T00_NATIVE_CANDIDATE_SHA == github.event.pull_request.head.sha";
    // The acquisition step has the same guard as its provisioning step: target it by name.
    const target = `name: Acquire the ordered T00 Windows milestone\n        ${guard}`;
    expect(source.includes(target)).toBe(true);
    expect(wiringProblems(source.replace(target, "name: Acquire the ordered T00 Windows milestone\n        if: true")))
      .toContain("Windows milestone must remain unique and bound to the authorized candidate");
    const command = "python tools/rust-ts-r0/qualification/run_windows_milestone.py";
    expect(wiringProblems(source.replace(command, `${command} ${command}`)))
      .toContain("Windows milestone must remain unique and bound to the authorized candidate");
  });
});
