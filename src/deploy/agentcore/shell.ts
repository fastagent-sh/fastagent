/**
 * A shell into the AgentCore runtime, for `fastagent login --deployment agentcore`: `InvokeAgentRuntimeCommandShell`,
 * a WebSocket to an interactive shell inside the running session. Opened on the fixed ingress session, so the shell
 * sees the same `/mnt/data` the server does.
 *
 * Authenticated with the same AWS credentials `deploy agentcore` uses, read from the AWS CLI
 * (`aws configure export-credentials`), so profiles, SSO and `aws login` all work with nothing else installed. The
 * URL is presigned (SigV4 in the query string, the SDK's `connectShellPresigned`), which needs no custom upgrade
 * header.
 *
 * The wire (the TypeScript SDK's `shell/protocol.ts`, the Kubernetes v5 channel protocol): every binary frame is one
 * channel byte then payload — 0 stdin, 1 stdout, 2 stderr, 3 status JSON, 5 heartbeat, 0xFF close. The shell is a
 * terminal, so the command switches it to raw, no echo (answers are not echoed back, and a long line is not cut by
 * the terminal's line editor) before handing it to `exec`.
 */
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { SignatureV4 } from "@smithy/signature-v4";
import { WebSocket, ping } from "undici";
import type { BoxChannel, BoxShell } from "../box-shell.ts";
import type { CliRunner } from "../runner.ts";
import { awsCli, awsJson } from "./aws-cli.ts";
import { MOUNT } from "./plan.ts";

const STDIN = 0x00;
const STDOUT = 0x01;
const STDERR = 0x02;
const STATUS = 0x03;
const HEARTBEAT = 0x05;
/** The service closes a connection whose frame is larger (code 1009). */
const MAX_PAYLOAD = 64 * 1024 - 1;
/** The SDK's interval; a connection with no ping for ~60s is dropped by the service. */
const KEEPALIVE_MS = 30_000;
/** The longest a presigned shell URL may live (the SDK refuses more). */
const PRESIGN_SECONDS = 300;

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** The AWS CLI's own credentials, the same ones every `deploy agentcore` call runs with. */
async function awsCliCredentials(aws: CliRunner): Promise<AwsCredentials> {
  const read = await awsCli(aws).read(
    ["configure", "export-credentials", "--format", "process"],
    awsJson((parsed) => {
      const p = parsed as { AccessKeyId?: unknown; SecretAccessKey?: unknown; SessionToken?: unknown };
      if (typeof p?.AccessKeyId !== "string" || typeof p.SecretAccessKey !== "string") return undefined;
      return {
        accessKeyId: p.AccessKeyId,
        secretAccessKey: p.SecretAccessKey,
        ...(typeof p.SessionToken === "string" ? { sessionToken: p.SessionToken } : {}),
      };
    }),
  );
  if ("ok" in read) return read.ok;
  throw new Error(
    `could not read AWS credentials from the AWS CLI (${"absent" in read ? "none configured" : read.unreadable})`,
  );
}

/** SHA-256 / HMAC-SHA-256 over node:crypto, in the shape SigV4's signer takes. */
class Sha256 {
  private readonly hash;
  constructor(secret?: string | ArrayBuffer | ArrayBufferView) {
    const key = secret instanceof ArrayBuffer ? Buffer.from(secret) : secret;
    this.hash = key === undefined ? createHash("sha256") : createHmac("sha256", key as string | NodeJS.ArrayBufferView);
  }
  update(data: string | ArrayBuffer | ArrayBufferView): void {
    this.hash.update(data instanceof ArrayBuffer ? Buffer.from(data) : (data as string | NodeJS.ArrayBufferView));
  }
  async digest(): Promise<Uint8Array> {
    return new Uint8Array(this.hash.digest());
  }
}

/** The runtime's region, from its ARN (`arn:<partition>:bedrock-agentcore:<region>:<account>:runtime/<id>`). */
function regionOf(runtimeArn: string): string {
  const region = runtimeArn.split(":")[3];
  if (!region) throw new Error(`not an AgentCore runtime ARN: ${runtimeArn}`);
  return region;
}

/** A presigned `wss://` URL for one shell on one runtime session: the SDK's `connectShellPresigned`. */
export async function presignShellUrl(input: {
  runtimeArn: string;
  sessionId: string;
  shellId: string;
  credentials: AwsCredentials;
  now?: Date;
}): Promise<string> {
  const region = regionOf(input.runtimeArn);
  const hostname = `bedrock-agentcore.${region}.amazonaws.com${region.startsWith("cn-") ? ".cn" : ""}`;
  const url = new URL(`https://${hostname}/runtimes/${encodeURIComponent(input.runtimeArn)}/ws/shells`);
  url.searchParams.set("shellId", input.shellId);
  url.searchParams.set("X-Amzn-Bedrock-AgentCore-Runtime-Session-Id", input.sessionId);
  const signed = await new SignatureV4({
    credentials: input.credentials,
    region,
    service: "bedrock-agentcore",
    sha256: Sha256,
  }).presign(
    {
      method: "GET",
      protocol: "https:",
      hostname,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: { host: hostname },
    },
    { expiresIn: PRESIGN_SECONDS, ...(input.now ? { signingDate: input.now } : {}) },
  );
  const query = Object.entries(signed.query ?? {})
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
  return `wss://${hostname}${signed.path}?${query}`;
}

/** What a status frame says: `undefined` for the connection confirmation, else how the shell exited. */
export function shellExit(status: string): string | undefined {
  const s = JSON.parse(status) as {
    metadata?: { shellId?: string };
    status?: string;
    details?: { causes?: { message?: string }[] };
  };
  if (s.metadata?.shellId) return undefined;
  return s.status === "Success" ? "exit 0" : `exit ${s.details?.causes?.[0]?.message ?? "(unknown)"}`;
}

/** Open `command` in a new shell on `url`: stdin/stdout as streams, the other channels folded in. */
export function openShellChannel(url: string, command: string): BoxChannel {
  const output = new PassThrough();
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const frame = (channel: number, payload: Buffer = Buffer.alloc(0)) =>
    ws.send(Buffer.concat([Buffer.from([channel]), payload]));
  const stdin = (bytes: Buffer): void => {
    for (let at = 0; at < bytes.length; at += MAX_PAYLOAD) frame(STDIN, bytes.subarray(at, at + MAX_PAYLOAD));
  };
  let exit: string | undefined;
  let failure: string | undefined;
  let keepalive: NodeJS.Timeout | undefined;
  const opened = new Promise<boolean>((resolve) => {
    ws.addEventListener("open", () => resolve(true), { once: true });
    ws.addEventListener("close", () => resolve(false), { once: true });
  });
  ws.addEventListener("open", () => {
    stdin(Buffer.from(`stty raw -echo 2>/dev/null; exec sh -c '${command}'\n`));
    keepalive = setInterval(() => {
      ping(ws);
      frame(HEARTBEAT);
    }, KEEPALIVE_MS);
  });
  ws.addEventListener("message", (event) => {
    const data = Buffer.from(event.data as ArrayBuffer);
    const payload = data.subarray(1);
    if (data[0] === STDOUT) output.write(payload);
    else if (data[0] === STDERR) process.stderr.write(payload);
    else if (data[0] === STATUS) exit = shellExit(payload.toString("utf8")) ?? exit;
  });
  ws.addEventListener("error", (event) => {
    failure = (event as { message?: string }).message || "connection failed";
  });
  const closed = new Promise<Awaited<BoxChannel["closed"]>>((resolve) => {
    ws.addEventListener("close", async (event) => {
      clearInterval(keepalive);
      output.end();
      if (!(await opened)) {
        resolve({
          opened: false,
          error:
            `could not open a shell on the AgentCore runtime (${failure ?? `closed ${event.code}`}) — it needs ` +
            `bedrock-agentcore:InvokeAgentRuntimeCommandShell, and a runtime created or redeployed after 2026-06-05`,
        });
        return;
      }
      resolve({ opened: true, how: exit ?? `WebSocket closed ${event.code}${event.reason ? ` ${event.reason}` : ""}` });
    });
  });
  const input = new Writable({
    write(chunk: Buffer, _encoding, done) {
      void opened.then((open) => {
        if (open && ws.readyState === WebSocket.OPEN) stdin(chunk);
        done();
      });
    },
  });
  return { output, input, closed };
}

/**
 * The shell `login --deployment` opens on an AgentCore runtime, on the session its server runs in. `wake` first sends
 * that session an IAM `probe`: the runtime prepares its storage only on an invocation, and after a deploy or an idle
 * reset nothing may have invoked it yet, which would leave the login no agent directory to run in.
 */
export function agentcoreShell(runtimeArn: string, sessionId: string, aws: CliRunner): BoxShell {
  return {
    storage: MOUNT,
    async wake() {
      const dir = await mkdtemp(join(tmpdir(), "fastagent-agentcore-wake-"));
      try {
        const reply = join(dir, "reply.json");
        const args = ["bedrock-agentcore", "invoke-agent-runtime", "--agent-runtime-arn", runtimeArn];
        args.push("--runtime-session-id", sessionId, "--payload", '{"kind":"probe"}');
        args.push("--cli-binary-format", "raw-in-base64-out", reply);
        const sent = await awsCli(aws).present(args);
        if (!("ok" in sent)) {
          const why = "absent" in sent ? "the runtime is not there" : sent.unreadable;
          throw new Error(`could not open the AgentCore runtime's storage (${why})`);
        }
        const answer = await readFile(reply, "utf8");
        if (!/"ok"\s*:\s*true/.test(answer)) {
          throw new Error(`the AgentCore runtime did not open its storage: ${answer.trim().slice(0, 300)}`);
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    async open(command) {
      const credentials = await awsCliCredentials(aws);
      return openShellChannel(
        await presignShellUrl({ runtimeArn, sessionId, shellId: randomUUID(), credentials }),
        command,
      );
    },
  };
}
