/**
 * The AgentCore command shell on Bun, where vitest does not run: CI's Bun job runs this file
 * (`bun test/bun/agentcore-shell.ts`), and test/agentcore-shell.test.ts holds the same contract on Node, against the
 * same stand-in. `login --deployment agentcore` is this channel; what Bun can differ in is `undici`'s WebSocket and the
 * ping that keeps the service from dropping a connection that has been quiet for a minute.
 */
import type { AddressInfo } from "node:net";
import { openShellChannel } from "../../src/deploy/agentcore/shell.ts";
import { shellService } from "../box-shell-stand-in.ts";

if (typeof process.versions.bun !== "string") throw new Error("run this with bun: bun test/bun/agentcore-shell.ts");

const failures: string[] = [];
function check(label: string, pass: boolean, detail: string): void {
  console.log(`${pass ? "ok  " : "FAIL"} ${label}${pass ? "" : `: ${detail}`}`);
  if (!pass) failures.push(label);
}

type Service = ReturnType<typeof shellService>;
async function listen(server: Service): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}/shell`;
}

const frame = (channel: number, text = "") => Buffer.concat([Buffer.from([channel]), Buffer.from(text)]);
const status = (extra: object) => frame(3, JSON.stringify({ kind: "Status", ...extra, status: "Success" }));
async function read(stream: NodeJS.ReadableStream): Promise<string> {
  let text = "";
  for await (const chunk of stream) text += String(chunk);
  return text;
}

// The keepalive waits 30 s before its first ping, so it runs beside the rest.
const keepalive = (async () => {
  const opcodes: number[] = [];
  const channels: number[] = [];
  const service = shellService(
    (channel, _payload, send) => {
      channels.push(channel);
      if (channels.length === 1) send(status({ metadata: { shellId: "s", reconnected: false } }));
    },
    (opcode) => opcodes.push(opcode),
  );
  const channel = openShellChannel(await listen(service), "sleep 100");
  channel.output.resume();
  await new Promise((resolve) => setTimeout(resolve, 31_500));
  check(
    "a quiet connection is kept alive with a WebSocket ping and a heartbeat frame",
    opcodes.includes(9) && channels.includes(5),
    JSON.stringify({ opcodes, channels }),
  );
  channel.input.end();
  service.close();
})();

{
  const seen: string[] = [];
  const service = shellService((channel, payload, send, close) => {
    seen.push(`${channel}:${payload}`);
    if (seen.length === 1) {
      send(status({ metadata: { shellId: "s", reconnected: false } }));
      send(frame(1, '{"type":"note","message":"hi"}\n'));
    } else {
      send(status({ metadata: {} }));
      close();
    }
  });
  const channel = openShellChannel(await listen(service), "echo box");
  const output = read(channel.output);
  channel.input.write('{"id":1,"value":"x"}\n');
  const out = await output;
  const closed = await channel.closed;
  check(
    "stdout, stdin and the exit status are relayed",
    out === '{"type":"note","message":"hi"}\n' && JSON.stringify(closed) === '{"opened":true,"how":"exit 0"}',
    JSON.stringify({ out, closed }),
  );
  check(
    "the command is handed to the terminal raw and unechoed",
    seen[0] === "0:stty raw -echo 2>/dev/null; exec sh -c 'echo box'\n" && seen[1] === '0:{"id":1,"value":"x"}\n',
    JSON.stringify(seen),
  );
  service.close();
}
{
  const service = shellService(() => {});
  const closed = await openShellChannel(`${await listen(service)}?refuse`, "true").closed;
  check(
    "a refused upgrade is a shell that never opened, naming what it needs",
    !closed.opened && /InvokeAgentRuntimeCommandShell/.test(closed.error),
    JSON.stringify(closed),
  );
  service.close();
}

await keepalive;
if (failures.length > 0) {
  console.error(`${failures.length} failed`);
  process.exit(1);
}
process.exit(0);
