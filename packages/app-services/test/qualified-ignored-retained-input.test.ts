import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobSelectionConfig } from "@semantic-context/core";
import { initWorkspace, loadConfig } from "@semantic-context/repository-store";
import { indexRepository, runVerify } from "../src";
import { captureQualifiedAnalysisInputs } from "../src/freshness";

for (const tracked of [false,true]) test(`ignored retained input tracked=${tracked}`, () => {
  const root=mkdtempSync(join(tmpdir(),"semctx-ignored-retained-"));
  const git=(...args:string[]):string=>{
    const result=Bun.spawnSync(["git",...args],{cwd:root,stdout:"pipe",stderr:"pipe"});
    if(result.exitCode!==0)throw Error(new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout);
  };
  try {
    mkdirSync(join(root,"src"));writeFileSync(join(root,".gitignore"),".semctx/\nsrc/hidden.ts\n");
    writeFileSync(join(root,"src/main.ts"),"export function main(){return 1;}\n");
    git("init","-q");git("add",".");
    if(tracked){writeFileSync(join(root,"src/hidden.ts"),"export function hidden(){return 1;}\n");git("add","-f","src/hidden.ts");}
    git("-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","-qm","fixture");
    initWorkspace(root,{...createGlobSelectionConfig(root),selectionMode:"qualified-static-v1",analysisProfile:"modelo-suite-static-v1",include:["src/**/*"]});
    if(!tracked)writeFileSync(join(root,"src/hidden.ts"),"export function hidden(){return 1;}\n");
    writeFileSync(join(root,"src/main.ts"),"export function main(){return 2;}\n");
    expect(captureQualifiedAnalysisInputs(loadConfig(root)).files.some(file=>file.path==="src/hidden.ts")).toBe(true);
    expect(git("ls-files","--others","--exclude-per-directory=.gitignore","-z")).not.toContain("src/hidden.ts");
    expect(git("ls-files","--others","-z").includes("src/hidden.ts")).toBe(!tracked);
    indexRepository(root,"2026-10-12T01:00:00.000Z");
    const report=runVerify(root,{kind:"working-tree"}).report;
    console.info(JSON.stringify({tracked,admission:report.analysisAdmission}));
    expect(report.analysisAdmission?.status).toBe(tracked?"admitted":"rejected");
    expect(report.analysisAdmission?.binding.status).toBe(tracked?"valid":"invalid");
    if(!tracked){
      expect(report.analysisAdmission?.binding.reasons).toEqual(["QUALIFIED_WORKING_TREE_UNTRACKED_INPUT:src/hidden.ts"]);
      const cli=join(import.meta.dir,"../../../apps/cli/src/index.ts");
      const result=Bun.spawnSync([process.execPath,cli,"verify","diff","--root",root,"--format","json","--fail-on","none"],{cwd:root,stdout:"pipe",stderr:"pipe"});
      expect(result.exitCode).toBe(3);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
},180_000);
