import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
const expected=JSON.parse(readFileSync(resolve(process.argv[2]),'utf8'));
const actual=JSON.parse(readFileSync(resolve(process.argv[3]),'utf8'));
if(JSON.stringify(expected)!==JSON.stringify(actual)){console.error('ORACLE_EXPECTATION_MISMATCH');process.exit(1);}
console.log(JSON.stringify({equal:true,cases:actual.length,programRecords:actual.reduce((n:any,r:any)=>n+r.actualProgramRecords.length,0)}));
