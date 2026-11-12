import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const [baseline, inputPath, outputPath] = process.argv.slice(2);
const core = await import(resolve(baseline, 'packages/core/src/index.ts'));
const { initWorkspace } = await import(resolve(baseline, 'packages/repository-store/src/index.ts'));
const { indexRepository } = await import(resolve(baseline, 'packages/app-services/src/indexing.ts'));
const { runVerify } = await import(resolve(baseline, 'packages/app-services/src/verify.ts'));
const { captureQualifiedAnalysisInputs } = await import(resolve(baseline, 'packages/app-services/src/freshness.ts'));
const { inspectRetainedQualifiedScope } = await import(resolve(baseline, 'packages/app-services/src/qualified-analysis.ts'));
const { analyzeRepository } = await import(resolve(baseline, 'packages/ts-analyzer/src/index.ts'));
const ts = (await import(resolve(baseline, 'node_modules/typescript/lib/typescript.js'))).default;
const units = [];
for (const unit of JSON.parse(readFileSync(inputPath, 'utf8')).units) {
  try {
    const config = { ...core.createGlobSelectionConfig(unit.root), selectionMode:'qualified-static-v1', analysisProfile:'modelo-suite-static-v1', include:['src/**/*.ts'] };
    initWorkspace(unit.root, config);
    indexRepository(unit.root, '2026-10-09T10:01:00.000Z');
    const consumedInputs = captureQualifiedAnalysisInputs(config);
    const retained = new Map(consumedInputs.files.map(file => [resolve(unit.root,file.path),Buffer.from(file.bytes).toString('utf8')]));
    const { graph } = analyzeRepository(config, undefined, retained);
    const scope = inspectRetainedQualifiedScope({ config, graph, consumedInputs, expectedInputHash:consumedInputs.digest, checkChanged:false, retainedCompilerInputs:retained });
    const verification = runVerify(unit.root, {kind:'working-tree'});
    units.push({id:unit.id, retainedPaths:consumedInputs.files.map(f=>f.path), retainedInput:{digest:consumedInputs.digest, files:consumedInputs.files.map(f=>({path:f.path,text:Buffer.from(f.bytes).toString('utf8')}))}, graph, scope, admission:verification.report.analysisAdmission, verdict:verification.result.verdict, inheritedConfiguration:retained.get(resolve(unit.root,'base.json'))});
  } catch(error) { units.push({id:unit.id,error:String(error),stack:error?.stack}); }
}
writeFileSync(outputPath, JSON.stringify({typescript:ts.version, baseline, units},null,2)+'\n');
