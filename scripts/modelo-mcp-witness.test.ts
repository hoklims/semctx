import { afterEach, expect, test, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyMcpWitness, type McpWitnessLimits } from "./modelo-mcp-witness";

const roots: string[] = [];
const descendants: number[] = [];
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
afterEach(() => {
  for (const pid of descendants.splice(0)) if (alive(pid)) process.kill(pid, "SIGKILL");
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const limits: McpWitnessLimits = { exchangeDeadlineMs: 1200, stdoutMaxBytes: 64 * 1024, stderrMaxBytes: 1024, terminateGraceMs: 50, teardownMs: 100 };
function fixture(body: string) {
  const root = mkdtempSync(join(tmpdir(), "modelo-mcp-witness-")); roots.push(root);
  const bundle = join(root, "server.mjs"); writeFileSync(bundle, body);
  return { root, bundle };
}
async function witness(body: string) {
  const { root, bundle } = fixture(body);
  const started = performance.now();
  const result = await verifyMcpWitness({ bundle, cwd: root, repositoryRoot: root, env: process.env, limits });
  expect(performance.now() - started).toBeLessThan(2500);
  expect(result.exitCode !== null || result.signalCode !== null).toBe(true);
  expect(alive(result.pid)).toBe(false);
  return result;
}

test("newline-free stdout flood is a named bounded protocol refusal", async () => {
  const result = await witness("process.stdin.resume(); process.stdout.write('x'.repeat(16*1024*1024)); setInterval(()=>{},1000000);");
  expect(result.failure?.code).toBe("MCP_STDOUT_LIMIT");
  expect(result.stdoutBytes).toBeGreaterThan(limits.stdoutMaxBytes);
});

test("silent child ignoring polite termination is refused and observably exited", async () => {
  const result = await witness("process.on('SIGTERM',()=>{}); process.stdin.resume(); setInterval(()=>{},1000000);");
  expect(result.failure?.code).toBe("MCP_EXCHANGE_DEADLINE");
});

test("early stdout closure retains stderr and a named refusal", async () => {
  const result = await witness("process.stderr.write('owned-close-early\\n'); process.exit(7);");
  expect(result.failure?.code).toBe("MCP_STDOUT_CLOSED");
  expect(result.stderr).toContain("owned-close-early");
  expect(result.exitCode).toBe(7);
});

test("inherited descendant pipes cannot make direct-child teardown unbounded", async () => {
  const { root, bundle } = fixture(`import { writeFileSync } from 'node:fs';
const child=Bun.spawn([process.execPath,'-e',"setInterval(()=>{},1000000)"],{stdin:'ignore',stdout:'inherit',stderr:'inherit'});
writeFileSync('descendant.pid',String(child.pid)); process.stdin.resume(); setInterval(()=>{},1000000);`);
  const started = performance.now();
  const result = await verifyMcpWitness({ bundle, cwd: root, repositoryRoot: root, env: process.env, limits });
  const descendant = Number(readFileSync(join(root, "descendant.pid"), "utf8")); descendants.push(descendant);
  expect(performance.now() - started).toBeLessThan(2500);
  expect(result.failure?.code).toBe("MCP_EXCHANGE_DEADLINE");
  expect(alive(result.pid)).toBe(false);
});

test("stderr flood is drained with bounded retained diagnostics", async () => {
  const result = await witness("process.stdin.resume(); process.stderr.write('e'.repeat(1024*1024)); setInterval(()=>{},1000000);");
  expect(result.failure?.code).toBe("MCP_EXCHANGE_DEADLINE");
  expect(result.stderrBytes).toBe(limits.stderrMaxBytes);
  expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(limits.stderrMaxBytes);
});

test("ordinary initialize and verification tool exchange remains complete", async () => {
  const result = await witness(`let buffer=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',chunk=>{
    buffer+=chunk; let end; while((end=buffer.indexOf('\\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1); const request=JSON.parse(line); if(!request.id)continue;
    const result=request.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'owned',version:'1'}}:{content:[],structuredContent:{verdict:'BLOCK'}};
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/message',params:{}})+'\\n');
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');}
  });`);
  expect(result.failure).toBeNull();
  expect(result.initialize?.serverInfo).toEqual({ name: "owned", version: "1" });
  expect(result.result?.structuredContent).toEqual({ verdict: "BLOCK" });
});

for (const stream of ["stdout", "stderr"] as const) test(`unfinished owned ${stream} teardown cannot report success`, async () => {
  const { root, bundle } = fixture(String.raw`let buffer='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{
    buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){const request=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);
    if(request.id)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{content:[]}})+'\n');}});`);
  const getReader = Reflect.get(ReadableStream.prototype, "getReader") as typeof ReadableStream.prototype.getReader;
  let readerIndex = 0;
  const stalledIndex = stream === "stdout" ? 0 : 1;
  const acquire = function (this: ReadableStream<Uint8Array>, options?: Parameters<typeof getReader>[0]): ReadableStreamDefaultReader<Uint8Array> {
    const reader = Reflect.apply(getReader, this, options === undefined ? [] : [options]) as ReadableStreamDefaultReader<Uint8Array>;
    if (readerIndex++ !== stalledIndex) return reader;
    const stalled = Object.create(reader) as ReadableStreamDefaultReader<Uint8Array>;
    stalled.read = async () => { const next = await reader.read(); return next.done ? new Promise<Awaited<ReturnType<typeof reader.read>>>(() => {}) : next; };
    stalled.cancel = () => new Promise<void>(() => {});
    return stalled;
  };
  const intercept = spyOn(ReadableStream.prototype, "getReader").mockImplementation(acquire as unknown as typeof ReadableStream.prototype.getReader);
  try {
    const result = await verifyMcpWitness({ bundle, cwd: root, repositoryRoot: root, env: process.env, limits: { ...limits, teardownMs: 40 } });
    expect(result.teardown.childExited).toBe(true);
    expect(alive(result.pid)).toBe(false);
    expect(result.teardown[`${stream}Closed`]).toBe(false);
    expect(result.teardown[`${stream}Cancelled`]).toBe(false);
    expect(result.failure?.code).toBe("MCP_TEARDOWN_INCOMPLETE");
  } finally { intercept.mockRestore(); }
});
