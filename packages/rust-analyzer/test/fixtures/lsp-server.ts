export {};

const mode = process.argv[2];
let bytes = Buffer.alloc(0);
for await (const chunk of Bun.stdin.stream()) {
  bytes = Buffer.concat([bytes, chunk]);
  for (;;) {
    const boundary = bytes.indexOf("\r\n\r\n");
    if (boundary < 0) break;
    const length = Number(/Content-Length: (\d+)/.exec(bytes.subarray(0, boundary).toString())?.[1]);
    if (bytes.length < boundary + 4 + length) break;
    const request = JSON.parse(bytes.subarray(boundary + 4, boundary + 4 + length).toString());
    bytes = bytes.subarray(boundary + 4 + length);
    if (mode === "hang") continue;
    if (mode === "corrupt") { await Bun.write(Bun.stdout, "Content-Length: invalid\r\n\r\n{}"); continue; }
    if (mode === "exit") process.exit(3);
    const body = JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { text: "🦀 café", method: request.method } });
    const frame = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    await Bun.write(Bun.stdout, frame.slice(0, 10));
    await Bun.write(Bun.stdout, frame.slice(10));
  }
}
