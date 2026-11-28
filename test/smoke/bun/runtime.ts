/**
 * End-to-end Bun runtime smoke test verifying FastAgent's full server & CLI contract on Bun >= 1.4.4:
 * - Public package imports across client, fastagent, agentcore, and harness-dsh
 * - Proxy setup (`installProxyFetch`) compatibility with Bun's native `undici` shim, dynamic `HTTP_PROXY` routing, and loopback exemption
 * - `openAgent` + `serve` (HTTP + SSE streaming + client disconnect abort) + `connectAgent` on both `pi-durable` and `dsh`
 * - Durable `node:sqlite` persistence across reopen and exclusive lock contention (`SQLITE_BUSY`)
 * - `@fastagent-sh/agentcore` `agentCoreHandler` HTTP envelope & `/ping`
 * - CLI under Bun: `--version`, `init --no-install`, `invoke` (both harnesses), `build`, `deploy init/check`, and `dev` IPC
 *
 * Run after `npm run build`: `bun --conditions=@fastagent-sh/source test/smoke/bun/runtime.ts`
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { connectAgent } from "@fastagent-sh/client";
import { openAgent } from "@fastagent-sh/fastagent";
import { defineDefinition } from "@fastagent-sh/fastagent/internal";
import { agentCoreHandler } from "../../../packages/agentcore/src/runtime.ts";
import { installProxyFetch } from "../../../packages/fastagent/src/proxy.ts";
import { openLockedStorage } from "../../../packages/fastagent/src/harnesses/pi-durable/storage.ts";
import { resolveFromProject, unsupportedRuntime } from "../../../packages/fastagent/src/runtime.ts";
import { serveHandler } from "../../../packages/fastagent/src/http/serve.ts";
import { servedPostgres } from "../../doubles/postgres-double.ts";

const REPO_ROOT = resolve(new URL("../../..", import.meta.url).pathname);
const CLI_DIST = join(REPO_ROOT, "packages/fastagent/dist/cli.js");

function makeDefinition(dir: string, name: string, config: Parameters<typeof defineDefinition>[0]["config"]) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SYSTEM.md"), "Be concise.\n");
  return defineDefinition({
    format: 2,
    builtWith: "0.0.0-bun-smoke",
    name,
    version: "0.0.0",
    dir,
    config,
    registry: { tools: [], extensions: [] },
  });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Bun smoke failed: ${message}`);
}

function assertEqual<T>(label: string, actual: T, expected: T): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Bun smoke failed (${label}): expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function runBunCli(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI_DIST, ...args], {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

assert(typeof process.versions.bun === "string", "must be executed under Bun");
assertEqual("unsupportedRuntime on Bun", unsupportedRuntime(), undefined);
assertEqual(
  "resolveFromProject does not trigger Bun auto-install",
  resolveFromProject(tmpdir(), "@fastagent-sh/nonexistent-bun-check/package.json"),
  undefined,
);
assert(existsSync(CLI_DIST), `missing built CLI at ${CLI_DIST}; run npm run build first`);

// 1. Public package imports
await Promise.all([
  import("@fastagent-sh/client"),
  import("@fastagent-sh/client-agentcore"),
  import("@fastagent-sh/fastagent"),
  import("@fastagent-sh/agentcore"),
  import("@fastagent-sh/harness-dsh"),
]);
console.error("[bun-smoke] 1/6 public imports ok");

// 2. Proxy boundary (dynamic HTTP_PROXY + loopback exemption) + SSE abort propagation on Bun's NodeHttpServer layer
{
  const proxiedUrls: string[] = [];
  const proxyServer = createServer((req, res) => {
    proxiedUrls.push(req.url ?? "");
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("via-proxy");
  });
  await new Promise<void>((resolveListen) => proxyServer.listen(0, "127.0.0.1", resolveListen));
  const proxyPort = (proxyServer.address() as AddressInfo).port;
  const savedProxyEnv = {
    HTTP_PROXY: process.env.HTTP_PROXY,
    http_proxy: process.env.http_proxy,
    NO_PROXY: process.env.NO_PROXY,
    no_proxy: process.env.no_proxy,
  };
  delete process.env.http_proxy;
  delete process.env.NO_PROXY;
  delete process.env.no_proxy;
  process.env.HTTP_PROXY = `http://127.0.0.1:${proxyPort}`;
  installProxyFetch();

  let aborted = false;
  const server = serveHandler(
    (req) => {
      req.signal.addEventListener("abort", () => {
        aborted = true;
      });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: ping\n\n"));
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
    { port: 0, host: "127.0.0.1" },
  );
  const port = await server.listening;
  try {
    // Non-loopback requests honor HTTP_PROXY set dynamically after startup.
    const proxiedRes = await fetch("http://example.invalid/bun-proxy-check");
    assertEqual("proxied response body", await proxiedRes.text(), "via-proxy");
    assertEqual("proxied request count", proxiedUrls.length, 1);

    // Loopback requests bypass HTTP_PROXY even when NO_PROXY is unset, and client abort propagates.
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}`, { signal: ac.signal });
    const reader = res.body?.getReader();
    assert(reader !== undefined, "expected SSE response body");
    const first = await reader.read();
    assertEqual("SSE chunk", new TextDecoder().decode(first.value), "data: ping\n\n");
    assertEqual("loopback bypassed proxy", proxiedUrls.length, 1);
    ac.abort();
    await new Promise((r) => setTimeout(r, 100));
    assert(aborted, "client abort must propagate to serveHandler request.signal on Bun");
  } finally {
    for (const [k, v] of Object.entries(savedProxyEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await server.close();
    await new Promise<void>((resolveClose) => proxyServer.close(() => resolveClose()));
  }
}
console.error("[bun-smoke] 2/6 proxy + HTTP SSE abort ok");

const work = mkdtempSync(join(tmpdir(), "fa-bun-smoke-"));
const cleanEnv: NodeJS.ProcessEnv = { ...process.env, HOME: join(work, "home") };
delete cleanEnv.FASTAGENT_MODEL;
delete cleanEnv.FASTAGENT_API_KEY;
delete cleanEnv.FASTAGENT_DATABASE_URL;
delete cleanEnv.FASTAGENT_NAME;
delete cleanEnv.FASTAGENT_ROOT;

try {
  // 3. Exclusive SQLite lock contention
  {
    const sqlitePath = join(work, "lock-test", "agent.sqlite");
    const first = await openLockedStorage(sqlitePath, "first-holder", 100);
    try {
      let lockedError: Error | undefined;
      try {
        await openLockedStorage(sqlitePath, "first-holder", 100);
      } catch (error) {
        lockedError = error as Error;
      }
      assert(lockedError !== undefined, "second openLockedStorage must fail when lock is held");
      assert(
        lockedError.message.includes("held by another process"),
        `unexpected lock error message: ${lockedError.message}`,
      );
    } finally {
      await first.close(BACKGROUND_CONTEXT);
    }
  }
  console.error("[bun-smoke] 3/6 node:sqlite exclusive lock ok");

  // 4. Embedded openAgent + serve + connectAgent + durable reopen on both harnesses
  for (const harness of ["pi-durable", "dsh"] as const) {
    const faux = fauxProvider({ provider: `bun-${harness}`, models: [{ id: "m1" }] });
    faux.setResponses([fauxAssistantMessage(`reply-1-${harness}`), fauxAssistantMessage(`reply-2-${harness}`)]);
    const agentDir = join(work, `def-${harness}`);
    const def = makeDefinition(agentDir, `bun-${harness}`, {
      model: `bun-${harness}/m1`,
      providers: [faux.provider],
      ...(harness === "dsh" ? { harness: "dsh", sandbox: "off" } : {}),
    });
    const root = join(work, `instance-${harness}`);
    const first = await openAgent(def, { root });
    let sessionId: string;
    try {
      const service = await first.serve({ apiKeys: ["bun-secret-key"] });
      const port = await service.listen(0, "127.0.0.1");
      const remote = connectAgent(`http://127.0.0.1:${port}`, { apiKey: "bun-secret-key" });
      const created = await remote.sessions.create();
      sessionId = created.id;
      const eventTypes: string[] = [];
      let finalText: string | undefined;
      for await (const event of remote.messages.stream({ sessionId, content: "hello" })) {
        eventTypes.push(event.type);
        if (event.type === "done") finalText = event.message.answer?.text;
      }
      assert(eventTypes.includes("message"), `${harness}: expected message SSE event, got ${eventTypes.join(",")}`);
      assert(eventTypes.includes("done"), `${harness}: expected done SSE event, got ${eventTypes.join(",")}`);
      assertEqual(`${harness} done answer`, finalText, `reply-1-${harness}`);
    } finally {
      await first.close();
    }

    // Reopen the durable SQLite store and continue the same session.
    const reopened = await openAgent(def, { root });
    try {
      const reply = await reopened.messages.send({ sessionId, content: "again" }, { wait: 30 });
      assertEqual(`${harness} durable reopen status`, reply.status, "completed");
      assertEqual(`${harness} durable reopen answer`, reply.answer?.text, `reply-2-${harness}`);
    } finally {
      await reopened.close();
    }
  }
  console.error("[bun-smoke] 4/6 embedded openAgent + HTTP SSE + durable reopen (pi-durable & dsh) ok");

  // 5. AgentCore runtime server under Bun
  {
    const pg = await servedPostgres();
    const faux = fauxProvider({ provider: "bun-ac", models: [{ id: "m1" }] });
    faux.setResponses([fauxAssistantMessage("agentcore-on-bun")]);
    const def = makeDefinition(join(work, "def-ac"), "bun-agentcore", {
      model: "bun-ac/m1",
      providers: [faux.provider],
    });
    const handler = agentCoreHandler(def, { database: { url: pg.url }, root: join(work, "ac-root") });
    const server = serveHandler(handler.fetch, { port: 0, host: "127.0.0.1" });
    const port = await server.listening;
    try {
      const ping = await fetch(`http://127.0.0.1:${port}/ping`);
      assertEqual("AgentCore /ping status", ping.status, 200);
      const sessionHeader = "bun-agentcore-session-id-0123456789abcdef";
      const createRes = await fetch(`http://127.0.0.1:${port}/invocations`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-amzn-bedrock-agentcore-runtime-session-id": sessionHeader,
        },
        body: JSON.stringify({
          request: {
            method: "POST",
            path: "/v1/sessions",
            headers: { "content-type": "application/json" },
            body: "{}",
          },
        }),
      });
      assertEqual("AgentCore create session status", createRes.status, 200);
      const created = (await createRes.json()) as { response: { status: number; body: string } };
      assertEqual("AgentCore envelope status", created.response.status, 201);
      const createdSession = JSON.parse(Buffer.from(created.response.body, "base64").toString("utf8")) as {
        id: string;
      };
      const sendRes = await fetch(`http://127.0.0.1:${port}/invocations`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-amzn-bedrock-agentcore-runtime-session-id": sessionHeader,
        },
        body: JSON.stringify({
          request: {
            method: "POST",
            path: `/v1/sessions/${createdSession.id}/messages`,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ content: "hi", wait: 30 }),
          },
        }),
      });
      assertEqual("AgentCore send message status", sendRes.status, 200);
      const sent = (await sendRes.json()) as { response: { status: number; body: string } };
      const sentMessage = JSON.parse(Buffer.from(sent.response.body, "base64").toString("utf8")) as {
        answer?: { text?: string };
      };
      assertEqual("AgentCore answer", sentMessage.answer?.text, "agentcore-on-bun");
    } finally {
      await server.close();
      await handler.close();
      await pg.close();
    }
  }
  console.error("[bun-smoke] 5/6 AgentCore runtime server ok");

  // 6. Full CLI workflow under Bun: --version, init, invoke (both harnesses), build, deploy init/check, dev IPC
  {
    const ver = runBunCli(["--version"], work, cleanEnv);
    assertEqual("CLI --version exit", ver.status, 0);
    assert(ver.stdout.trim().length > 0, "CLI --version must print version");

    const agentDir = join(work, "cli-agent");
    const initRes = runBunCli(["init", agentDir, "--no-install"], work, cleanEnv);
    assertEqual(`CLI init exit (${initRes.stderr})`, initRes.status, 0);
    assert(initRes.stderr.includes("bun install"), `expected bun install hint on Bun, got: ${initRes.stderr}`);
    assert(initRes.stderr.includes("bun run --bun dev"), `expected bun dev hint on Bun, got: ${initRes.stderr}`);

    // Link workspace node_modules into the temp agent dir so build/invoke resolve local packages offline.
    writeFileSync(join(agentDir, "bun.lock"), "{}\n");
    writeFileSync(
      join(agentDir, "fastagent.config.ts"),
      `import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { AgentConfig } from "@fastagent-sh/fastagent";

const faux = fauxProvider({ provider: "bun-cli", models: [{ id: "m" }] });
faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage("bun-cli-pong")));

export default { model: "bun-cli/m", providers: [faux.provider] } satisfies AgentConfig;
`,
    );
    // Point NODE_PATH / symlink node_modules for fast offline resolution inside the repo.
    const symlinkRes = spawnSync("ln", ["-s", join(REPO_ROOT, "node_modules"), join(agentDir, "node_modules")]);
    assertEqual("symlink node_modules", symlinkRes.status, 0);

    const invokePi = runBunCli(["-C", agentDir, "invoke", "ping", "--no-input"], work, cleanEnv);
    assertEqual(`CLI invoke pi-durable (${invokePi.stderr})`, invokePi.status, 0);
    assertEqual("CLI invoke pi-durable stdout", invokePi.stdout.trim(), "bun-cli-pong");

    const invokeDsh = runBunCli(
      ["-C", agentDir, "invoke", "ping", "--harness", "dsh", "--sandbox", "off", "--no-input"],
      work,
      cleanEnv,
    );
    assertEqual(`CLI invoke dsh (${invokeDsh.stderr})`, invokeDsh.status, 0);
    assertEqual("CLI invoke dsh stdout", invokeDsh.stdout.trim(), "bun-cli-pong");

    const buildRes = runBunCli(["-C", agentDir, "build", "--json"], work, cleanEnv);
    assertEqual(`CLI build (${buildRes.stderr})`, buildRes.status, 0);
    const builtInfo = JSON.parse(buildRes.stdout) as { dist: string };
    assert(existsSync(join(builtInfo.dist, "index.js")), "build must emit dist/index.js");

    // Open the built artifact directly under Bun.
    const builtMod = (await import(join(builtInfo.dist, "index.js"))) as { default: Parameters<typeof openAgent>[0] };
    const builtAgent = await openAgent(builtMod.default, { root: join(work, "built-root") });
    try {
      const { id } = await builtAgent.sessions.create();
      const msg = await builtAgent.messages.send({ sessionId: id, content: "ping" }, { wait: 30 });
      assertEqual("built dist/index.js answer", msg.answer?.text, "bun-cli-pong");
    } finally {
      await builtAgent.close();
    }

    const deployInit = runBunCli(["-C", agentDir, "deploy", "init", "docker"], work, cleanEnv);
    assertEqual(`CLI deploy init docker (${deployInit.stderr})`, deployInit.status, 0);
    const dockerfile = readFileSync(join(agentDir, "Dockerfile"), "utf8");
    assert(dockerfile.includes("FROM oven/bun:1"), `expected Bun Dockerfile, got:\n${dockerfile}`);
    assert(dockerfile.includes("RUN bun install --frozen-lockfile"), "expected frozen bun install");
    assert(dockerfile.includes("RUN bun ./node_modules/.bin/fastagent build"), "expected bun build step");
    assert(dockerfile.includes('CMD ["bun", "./node_modules/.bin/fastagent", "start"]'), "expected bun CMD");

    const deployCheck = runBunCli(["-C", agentDir, "deploy", "check", "--json"], work, cleanEnv);
    assertEqual(`CLI deploy check (${deployCheck.stderr})`, deployCheck.status, 0);
    const checkJson = JSON.parse(deployCheck.stdout) as { ok: boolean; leaks: string[] };
    assertEqual("CLI deploy check ok", checkJson.ok, true);
    assertEqual("CLI deploy check leaks", checkJson.leaks, []);

    // Verify `fastagent dev` supervisor spawns its worker with Bun IPC and shuts down cleanly on SIGTERM.
    const devChild = spawn(process.execPath, [CLI_DIST, "-C", agentDir, "dev", "--port", "0", "--no-input"], {
      cwd: work,
      env: cleanEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let devStderr = "";
    const readyUrl = await new Promise<string>((resolveReady, rejectReady) => {
      const timeout = setTimeout(() => rejectReady(new Error(`dev timed out; stderr:\n${devStderr}`)), 15_000);
      devChild.stderr.on("data", (chunk: Buffer) => {
        devStderr += chunk.toString("utf8");
        const match = /http host on (127\.0\.0\.1:\d+)/.exec(devStderr);
        if (match !== null) {
          clearTimeout(timeout);
          resolveReady(`http://${match[1]}`);
        }
      });
      devChild.on("exit", (code) => {
        clearTimeout(timeout);
        rejectReady(new Error(`dev exited early (${code}); stderr:\n${devStderr}`));
      });
    });
    const health = await fetch(`${readyUrl}/health`);
    assertEqual("dev /health status", health.status, 200);
    devChild.kill("SIGTERM");
    await new Promise<void>((resolveExit) => devChild.once("exit", () => resolveExit()));
  }
  console.error("[bun-smoke] 6/6 CLI workflow (init, invoke, build, deploy, dev IPC) ok");
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.error(`[bun-smoke] all checks passed on Bun ${process.versions.bun}`);
process.exit(0);
