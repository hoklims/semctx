import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHILD_TIMEOUT_MS = 60_000;
const repositoryRoot = join(import.meta.dir, "../../..");

function childSource(): string {
  return `import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {lstatSync,mkdirSync,readFileSync,realpathSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {createGlobSelectionConfig,VerifyReportSchema} from "@semantic-context/core";
import {initWorkspace,loadConfig} from "@semantic-context/repository-store";
import {indexRepository,runVerify} from ${JSON.stringify(join(repositoryRoot, "packages/app-services/src/index.ts"))};
const scenario=process.env.SEMCTX_TEMP_ROOT_SCENARIO;
const temporary=process.env.SEMCTX_TEMP_ROOT_PATH;
const physical=process.env.SEMCTX_TEMP_ROOT_PHYSICAL;
const root=process.env.SEMCTX_TEMP_ROOT_REPOSITORY;
assert.ok(scenario&&temporary&&physical&&root,"child scenario paths must be supplied");
assert.equal(resolve(tmpdir()),resolve(temporary),"the real child os.tmpdir must consume its isolated environment");
assert.equal(realpathSync.native(tmpdir()),physical,"temp alias must resolve to the actual physical directory");
assert.equal(resolve(tmpdir())!==physical,scenario!=="canonical-body","alias scenarios must traverse a real directory link");
assert.equal(lstatSync(tmpdir()).isSymbolicLink(),scenario!=="canonical-body","the aliased temporary directory must actually be a symlink or junction");
mkdirSync(root);
assert.equal(realpathSync.native(root),root,"the live fixture root must already be canonical");
const guarded="/** @invariant fixed: stays fixed */\\nexport function value() { return 1; }\\n";
mkdirSync(join(root,"src"));
writeFileSync(join(root,".gitignore"),".semctx/\\n");
writeFileSync(join(root,"src/value.ts"),guarded);
if(scenario!=="alias-marker"){
 mkdirSync(join(root,"test"));
 writeFileSync(join(root,"test/value.test.ts"),'import { expect, test } from "bun:test";\\nimport { value } from "../src/value";\\ntest("value", () => expect(value()).toBe(1));\\n');
}
const git=(...args)=>{
 const result=Bun.spawnSync(["git","-c","user.name=Semctx Test","-c","user.email=semctx@example.test","-c","commit.gpgsign=false","-c","core.autocrlf=false",...args],{cwd:root,stdout:"pipe",stderr:"pipe"});
 assert.equal(result.exitCode,0,new TextDecoder().decode(result.stderr));
 return new TextDecoder().decode(result.stdout);
};
git("init","-q","-b","main");git("add",".");git("commit","-q","-m","guarded base");
assert.equal(git("show","HEAD:src/value.ts"),guarded,"immutable HEAD must retain the original guard bytes");
initWorkspace(root,{...createGlobSelectionConfig(root),selectionMode:"qualified-static-v1",analysisProfile:"modelo-suite-static-v1",include:["src/**/*","test/**/*"]});
assert.equal(loadConfig(root).repositoryRoot,root);
writeFileSync(join(root,"src/value.ts"),scenario==="alias-marker"?"export function value() { return 1; }\\n":guarded.replace("return 1","return 2"));
indexRepository(root,"2026-10-12T00:00:00.000Z");
const hash=bytes=>createHash("sha256").update(bytes).digest("hex");
const before={head:git("rev-parse","HEAD").trim(),inventory:git("ls-tree","-r","HEAD"),diff:git("diff","--no-ext-diff","--no-textconv","HEAD","--"),index:hash(readFileSync(join(root,".git/index"))),source:hash(readFileSync(join(root,"src/value.ts"))),headSource:hash(guarded)};
assert.ok(/^-[^-]/m.test(before.diff),"the control must actually remove base lines");
const report=runVerify(root,{kind:"working-tree"}).report;
console.info(JSON.stringify({scenario,temporary:tmpdir(),physical,root,before,report}));
assert.equal(hash(readFileSync(join(root,".git/index"))),before.index,"old capture must not mutate the live Git index");
assert.equal(git("rev-parse","HEAD").trim(),before.head);
assert.equal(git("ls-tree","-r","HEAD"),before.inventory);
assert.equal(git("diff","--no-ext-diff","--no-textconv","HEAD","--"),before.diff);
assert.equal(hash(readFileSync(join(root,"src/value.ts"))),before.source);
assert.equal(VerifyReportSchema.safeParse(report).success,true,"the actual public report must validate");
assert.equal(report.analysisAdmission?.indexFreshness.verdict,"DIRTY_KNOWN");
assert.equal(report.analysisAdmission?.checkFreshness.status,"current");
assert.ok(report.analysisAdmission?.changeCoverage.analyzed.includes("src/value.ts"));
if(scenario==="alias-marker"){
 assert.ok(report.findings.some(finding=>finding.rule==="invariant_touched_without_test"&&finding.severity==="block"),"linked-temp capture must recover the original strict invariant rule, not only a layout refusal");
 assert.equal(report.verdict,"BLOCK");
}else{
 assert.equal(report.analysisAdmission?.status,"admitted","covered body replacement must remain admitted when private temp root has an alias ancestor");
 assert.notEqual(report.verdict,"BLOCK");
 assert.ok(report.recommendedTests.some(item=>item.file==="test/value.test.ts"));
}
assert.equal(report.analysisAdmission?.status,"admitted");
assert.equal(report.analysisAdmission?.binding.status,"valid");
`;
}

for (const scenario of ["canonical-body", "alias-body", "alias-marker"] as const) {
  test(`qualified immutable HEAD capture uses a safe physical temp root: ${scenario}`, () => {
    const base = realpathSync.native(mkdtempSync(join(tmpdir(), "semctx-retained-temp-root-")));
    try {
      const physical = join(base, "physical-temp");
      mkdirSync(physical);
      const alias = join(base, "alias-temp");
      if (scenario !== "canonical-body") symlinkSync(physical, alias, process.platform === "win32" ? "junction" : "dir");
      const temporary = scenario === "canonical-body" ? physical : alias;
      const child = Bun.spawnSync([process.execPath, "-e", childSource()], {
        cwd: repositoryRoot, stdout: "pipe", stderr: "pipe", timeout: CHILD_TIMEOUT_MS,
        env: { ...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary,
          SEMCTX_TEMP_ROOT_SCENARIO: scenario, SEMCTX_TEMP_ROOT_PATH: temporary,
          SEMCTX_TEMP_ROOT_PHYSICAL: physical, SEMCTX_TEMP_ROOT_REPOSITORY: join(base, "repository") },
      });
      console.info(new TextDecoder().decode(child.stdout));
      console.info(new TextDecoder().decode(child.stderr));
      expect(child.exitCode).toBe(0);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, CHILD_TIMEOUT_MS);
}
