import ts from './vendor/typescript/lib/typescript.js';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const hash=(x:any)=>createHash('sha256').update(x).digest('hex');
export const records:any[]=[];
export function observe(program:any,inputs:any,sourcePath:string){
 const checker=program.getTypeChecker(),source=program.getSourceFile(sourcePath),origins:any[]=[];
 const origin=(d:any)=>({path:d.getSourceFile().fileName,kind:ts.SyntaxKind[d.kind],pos:d.pos,end:d.end,text:d.getText(),defaultLibrary:program.isSourceFileDefaultLibrary(d.getSourceFile()),fileSha256:hash(d.getSourceFile().text)});
 const walk=(n:any)=>{if(ts.isIdentifier(n)&&n.text==='navigator'){const symbol=ts.isShorthandPropertyAssignment(n.parent)?checker.getShorthandAssignmentValueSymbol(n.parent):checker.getSymbolAtLocation(n);origins.push({text:n.getText(),pos:n.pos,end:n.end,parentKind:ts.SyntaxKind[n.parent.kind],symbolName:symbol?.getName(),declarations:(symbol?.getDeclarations()??[]).map(origin)});}ts.forEachChild(n,walk);};walk(source);
 records.push({sourcePath,compilerVersion:ts.version,currentDirectory:program.getCurrentDirectory(),caseSensitive:ts.sys.useCaseSensitiveFileNames,rootNames:program.getRootFileNames(),options:program.getCompilerOptions(),retained:[...inputs],files:program.getSourceFiles().map((f:any)=>({path:f.fileName,size:Buffer.byteLength(f.text),sha256:hash(f.text),defaultLibrary:program.isSourceFileDefaultLibrary(f)})),origins});
}
