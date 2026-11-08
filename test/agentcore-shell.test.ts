import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { agentcoreShell, openShellChannel, presignShellUrl, shellExit } from "../src/deploy/agentcore/shell.ts";
import type { CliRunner } from "../src/deploy/runner.ts";
import { shellService } from "./box-shell-stand-in.ts";

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});
async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}/shell`;
}

const frame = (channel: number, text = "") => Buffer.concat([Buffer.from([channel]), Buffer.from(text)]);
const read = async (stream: NodeJS.ReadableStream) => {
  let text = "";
  for await (const chunk of stream) text += String(chunk);
  return text;
};

describe("the AgentCore shell channel", () => {
  it("hands the command to the terminal raw and unechoed, then relays stdout, stdin and the exit status", async () => {
    const seen: string[] = [];
    const url = await listen(
      shellService((channel, payload, send, close) => {
        seen.push(`${channel}:${payload}`);
        if (seen.length === 1) {
          send(
            frame(
              3,
              JSON.stringify({ kind: "Status", metadata: { shellId: "s", reconnected: false }, status: "Success" }),
            ),
          );
          send(frame(1, '{"type":"note","message":"hi"}\n'));
        } else {
          send(frame(3, JSON.stringify({ kind: "Status", metadata: {}, status: "Success" })));
          close();
        }
      }),
    );
    const channel = openShellChannel(url, "echo box");
    const output = read(channel.output);
    channel.input.write('{"id":1,"value":"x"}\n');
    expect(await output).toBe('{"type":"note","message":"hi"}\n');
    expect(await channel.closed).toEqual({ opened: true, how: "exit 0" });
    expect(seen).toEqual([`0:stty raw -echo 2>/dev/null; exec sh -c 'echo box'\n`, `0:{"id":1,"value":"x"}\n`]);
  });

  it("a refused upgrade is a shell that never opened, and says what the caller needs", async () => {
    const url = await listen(shellService(() => {}));
    const channel = openShellChannel(`${url}?refuse`, "true");
    const closed = await channel.closed;
    expect(closed.opened).toBe(false);
    if (!closed.opened) expect(closed.error).toMatch(/InvokeAgentRuntimeCommandShell/);
  });

  it("reads a non-zero exit out of the status frame", () => {
    expect(
      shellExit(
        JSON.stringify({
          status: "Failure",
          reason: "NonZeroExitCode",
          details: { causes: [{ reason: "ExitCode", message: "3" }] },
        }),
      ),
    ).toBe("exit 3");
    expect(shellExit(JSON.stringify({ metadata: { shellId: "s" }, status: "Success" }))).toBeUndefined();
  });

  it("presigns the shell URL of the runtime's own region, with the session and shell in the signed query", async () => {
    const arn = "arn:aws:bedrock-agentcore:ap-southeast-1:123456789012:runtime/fa_x-AbC";
    const url = new URL(
      await presignShellUrl({
        runtimeArn: arn,
        sessionId: "fastagent-ingress-x000000000000000",
        shellId: "sh1",
        credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret", sessionToken: "tok" },
        now: new Date("2026-09-30T00:00:00Z"),
      }),
    );
    expect(url.protocol).toBe("wss:");
    expect(url.host).toBe("bedrock-agentcore.ap-southeast-1.amazonaws.com");
    expect(url.pathname).toBe(`/runtimes/${encodeURIComponent(arn)}/ws/shells`);
    expect(url.searchParams.get("shellId")).toBe("sh1");
    expect(url.searchParams.get("X-Amzn-Bedrock-AgentCore-Runtime-Session-Id")).toBe(
      "fastagent-ingress-x000000000000000",
    );
    expect(url.searchParams.get("X-Amz-Credential")).toBe(
      "AKIDEXAMPLE/20260930/ap-southeast-1/bedrock-agentcore/aws4_request",
    );
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(url.searchParams.get("X-Amz-Security-Token")).toBe("tok");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("waking the AgentCore runtime before its shell opens", () => {
  const ARN = "arn:aws:bedrock-agentcore:ap-southeast-1:123456789012:runtime/fa_x-AbC";
  const SESSION = "fastagent-ingress-x000000000000000";
  /** `invoke-agent-runtime` writes the container's reply to its last argument, the outfile. */
  const fakeAws = (reply: string, code = 0, stderr = "") => {
    const calls: string[][] = [];
    const aws: CliRunner = async (args) => {
      calls.push(args);
      if (code === 0) await writeFile(args.at(-1) as string, reply);
      return { code, stdout: "", stderr };
    };
    return { aws, calls };
  };

  it("sends the ingress session an IAM probe, so the workspace exists before the login needs it", async () => {
    const { aws, calls } = fakeAws('{"ok":true}');
    await agentcoreShell(ARN, SESSION, aws).wake?.();
    const args = calls[0] as string[];
    expect(args.slice(0, 2)).toEqual(["bedrock-agentcore", "invoke-agent-runtime"]);
    expect(args[args.indexOf("--agent-runtime-arn") + 1]).toBe(ARN);
    expect(args[args.indexOf("--runtime-session-id") + 1]).toBe(SESSION);
    expect(args[args.indexOf("--payload") + 1]).toBe('{"kind":"probe"}');
  });

  it("names why when the runtime could not open, or the call failed", async () => {
    const failedInit = fakeAws('{"ok":false,"error":"initialization failed: no mount"}');
    await expect(agentcoreShell(ARN, SESSION, failedInit.aws).wake?.()).rejects.toThrow(/no mount/);
    const denied = fakeAws("", 254, "An error occurred (AccessDeniedException) when calling InvokeAgentRuntime");
    await expect(agentcoreShell(ARN, SESSION, denied.aws).wake?.()).rejects.toThrow(/AccessDeniedException/);
  });
});
