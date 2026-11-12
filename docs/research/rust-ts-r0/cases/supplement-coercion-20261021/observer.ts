import {resolve,join}from'node:path';import{createHash}from'node:crypto';
const dependency=resolve(process.argv[process.argv.indexOf('--dependency-root')+1]);
const ts=(await import(join(dependency,'vendor/typescript/lib/typescript.js'))).default;
const hash=(x:any)=>createHash('sha256').update(x).digest('hex');
export const records:any[]=[];
export function observe(program:any,inputs:any,sourcePath:string){
 const checker=program.getTypeChecker(),source=program.getSourceFile(sourcePath),binaryExpressions:any[]=[];
 const origin=(d:any)=>({path:d.getSourceFile().fileName,kind:ts.SyntaxKind[d.kind],pos:d.pos,end:d.end,text:d.getText(),defaultLibrary:program.isSourceFileDefaultLibrary(d.getSourceFile()),fileSha256:hash(d.getSourceFile().text)});
 const operand=(n:any)=>{const type=checker.getTypeAtLocation(n);return{text:n.getText(),kind:ts.SyntaxKind[n.kind],typeFlags:type.flags,typeString:checker.typeToString(type),typeDeclarations:(type.getSymbol()?.getDeclarations()??[]).map(origin),symbolDeclarations:(checker.getSymbolAtLocation(n)?.getDeclarations()??[]).map(origin)};};
 const walk=(n:any)=>{if(ts.isBinaryExpression(n))binaryExpressions.push({text:n.getText(),pos:n.pos,end:n.end,operator:ts.SyntaxKind[n.operatorToken.kind],left:operand(n.left),right:operand(n.right)});ts.forEachChild(n,walk);};walk(source);
 records.push({sourcePath,compilerVersion:ts.version,currentDirectory:program.getCurrentDirectory(),caseSensitive:ts.sys.useCaseSensitiveFileNames,rootNames:program.getRootFileNames(),options:program.getCompilerOptions(),retained:[...inputs],files:program.getSourceFiles().map((f:any)=>({path:f.fileName,size:Buffer.byteLength(f.text),sha256:hash(f.text),defaultLibrary:program.isSourceFileDefaultLibrary(f)})),binaryExpressions});
}
