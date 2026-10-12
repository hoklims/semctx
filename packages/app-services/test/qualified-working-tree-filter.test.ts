import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { initWorkspace, loadConfig } from "@semantic-context/repository-store";
import { indexRepository, runVerify } from "../src";
import { captureQualifiedAnalysisInputs } from "../src/freshness";
import { retainedWorkingTreeFilterPaths } from "../src/verification-state";

for (const [name, attributes, driver, qualified] of [
  ["active qualified", "*.ts filter=drop\n", true, true],
  ["active ordinary", "*.ts filter=drop\n", true, false],
  ["named unconfigured", "*.ts filter=drop\n", false, true],
  ["text normalization", "*.ts text eol=lf\n", false, true],
  ["reserved configured", "*.ts filter=unset\n", true, true],
] as const) test(`working-tree filter ${name}`, () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-filter-scope-"));
  const git = (...args: string[]): string => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw Error(new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout);
  };
  try {
    mkdirSync(join(root,"src")); writeFileSync(join(root,".gitignore"),".semctx/\n");
    writeFileSync(join(root,".gitattributes"),attributes);
    writeFileSync(join(root,"src/main.ts"),"export function main(){return 3;}\n");
    const hidden = join(root,"src/hidden.ts"); const before="export function hidden(){return 1;}\n";
    writeFileSync(hidden,before);
    writeFileSync(join(root,"src/hidden.test.ts"),"import {hidden} from './hidden';export function check(){return hidden();}\n");
    git("init","-q");
    if(driver){
      const script=join(root,".git/drop.cjs");
      writeFileSync(script,"let text='';process.stdin.on('data',chunk=>text+=chunk);process.stdin.on('end',()=>process.stdout.write(text.replaceAll('return 2','return 1')));\n");
      git("config","--local",`filter.${name === "reserved configured" ? "unset" : "drop"}.clean`,`"${process.execPath.replaceAll("\\","/")}" "${script.replaceAll("\\","/")}"`);
    }
    git("add",".");git("-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-qm","fixture");
    initWorkspace(root,{...createGlobSelectionConfig(root),...(qualified?{selectionMode:"qualified-static-v1" as const,analysisProfile:"modelo-suite-static-v1" as const}:{}),include:["src/**/*"]});
    writeFileSync(hidden,"export function hidden(){return 2;}\n");writeFileSync(join(root,"src/main.ts"),"export function main(){return 4;}\n");
    const paths=git("diff","--name-only","HEAD").trim().split("\n");
    expect(paths).toContain("src/main.ts");expect(paths.includes("src/hidden.ts")).toBe(!driver);
    expect(createHash("sha256").update(readFileSync(hidden)).digest("hex")).not.toBe(createHash("sha256").update(before).digest("hex"));
    if(qualified)expect(captureQualifiedAnalysisInputs(loadConfig(root)).files.some(file=>file.path==="src/hidden.ts")).toBe(true);
    indexRepository(root,"2026-10-12T03:00:00.000Z");
    const report=runVerify(root,{kind:"working-tree"}).report;
    console.info(JSON.stringify({name,git:git("--version").trim(),attributes:git("check-attr","filter","--","src/hidden.ts").trim(),rawBefore:createHash("sha256").update(before).digest("hex"),rawAfter:createHash("sha256").update(readFileSync(hidden)).digest("hex"),diffPaths:paths,admission:report.analysisAdmission,recommendedTests:report.recommendedTests}));
    expect(report.analysisAdmission?.status).toBe(qualified?(driver?"rejected":"admitted"):undefined);
    if(qualified&&driver){
      expect(report.analysisAdmission?.binding.reasons).toContain("QUALIFIED_WORKING_TREE_FILTER_UNSUPPORTED:src/hidden.ts");
      const result=Bun.spawnSync([process.execPath,join(import.meta.dir,"../../../apps/cli/src/index.ts"),"verify","diff","--root",root,"--format","json","--fail-on","none"],{cwd:root,stdout:"pipe",stderr:"pipe"});expect(result.exitCode).toBe(3);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},180_000);

test("process-only filter authority is inspected without executing its command", () => {
  const root = mkdtempSync(join(tmpdir(), "semctx-process-filter-"));
  try {
    mkdirSync(join(root,"src")); writeFileSync(join(root,"src/main.ts"),"export function main(){return 1;}\n");
    writeFileSync(join(root,".gitattributes"),"*.ts filter=pipe\n");
    expect(Bun.spawnSync(["git","init","-q"],{cwd:root,stdout:"pipe",stderr:"pipe"}).exitCode).toBe(0);
    const marker=join(root,".git/executed");const script=join(root,".git/process.cjs");
    writeFileSync(script,`require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed');\n`);
    const command=`"${process.execPath.replaceAll("\\","/")}" "${script.replaceAll("\\","/")}"`;
    expect(Bun.spawnSync(["git","config","--local","filter.pipe.process",command],{cwd:root,stdout:"pipe",stderr:"pipe"}).exitCode).toBe(0);
    expect(retainedWorkingTreeFilterPaths(root,["src/main.ts"])).toEqual(["src/main.ts"]);
    expect(existsSync(marker)).toBe(false);
  } finally {rmSync(root,{recursive:true,force:true});}
});
