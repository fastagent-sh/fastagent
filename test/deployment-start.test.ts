import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

// This test pays a project compile plus TWO cold harness starts in child processes: ~3s on an idle
// machine, but a full `npm test` run puts a fork on every core and has been measured past the old 30s
// ceiling. The budget is raised, not the parallelism (vitest.config.ts states why). The child ceiling
// stays the tighter of the two so a hung child is reported as itself, not as an opaque test timeout.
const CHILD_TIMEOUT_MS = 45_000;

it("retries interrupted installs, opens the deployed agent's runtime and preserves tool context and rotated credentials", async () => {
  const repo = dirname(dirname(fileURLToPath(import.meta.url)));
  const dir = await mkdtemp(join(tmpdir(), "fa-deployment-start-"));
  const root = join(dir, "data"),
    agent = join(dir, "image", "definition"); // the image's baked definition
  const packageDir = join(agent, "node_modules/@fastagent-sh/fastagent");
  const exec = promisify(execFile);
  let requests = 0;
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* Drain the model request before replying. */
    }
    const tool = requests++ === 0;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const delta = tool
      ? {
          role: "assistant",
          tool_calls: [
            { index: 0, id: "call_context", type: "function", function: { name: "context", arguments: "{}" } },
          ],
        }
      : { role: "assistant", content: "done" };
    for (const choice of [
      { index: 0, delta, finish_reason: null },
      { index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" },
    ]) {
      res.write(
        `data: ${JSON.stringify({ id: "reply", object: "chat.completion.chunk", created: 1, model: "test", choices: [choice] })}\n\n`,
      );
    }
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await mkdir(packageDir, { recursive: true });
    await exec(process.execPath, [
      join(repo, "node_modules/typescript/bin/tsc"),
      "-p",
      join(repo, "tsconfig.build.json"),
      "--outDir",
      join(packageDir, "dist"),
    ]);
    await symlink(join(repo, "node_modules"), join(packageDir, "node_modules"), "dir");
    await writeFile(
      join(packageDir, "package.json"),
      JSON.stringify({ name: "@fastagent-sh/fastagent", version: "0.0.0", type: "module", exports: "./dist/index.js" }),
    );
    await mkdir(join(agent, "node_modules/.bin"));
    // The packages the agent's own code imports, as its install would bring them.
    await symlink(join(repo, "node_modules/@earendil-works"), join(agent, "node_modules/@earendil-works"), "dir");
    await writeFile(join(agent, "package.json"), '{"type":"module"}');
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    await writeFile(
      join(agent, "fastagent.config.ts"),
      `import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
const model = {
  id: "test", name: "Test", api: "openai-completions", provider: "local", baseUrl: ${JSON.stringify(baseUrl)},
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32768, maxTokens: 1024,
};
export default {
  model: "local/test",
  providers: [
    createProvider({
      id: "local", name: "Local", baseUrl: ${JSON.stringify(baseUrl)},
      auth: { apiKey: { name: "Local", resolve: async () => ({ auth: { apiKey: "test" } }) } },
      models: [model], api: openAICompletionsApi(),
    }),
  ],
};
`,
    );
    await writeFile(join(agent, "SYSTEM.md"), "Use the context tool.");
    await mkdir(join(agent, "src/tools"), { recursive: true });
    await writeFile(
      join(agent, "src/tools/context.mjs"),
      `import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { sessionIdOf } from "@fastagent-sh/fastagent";
export default defineTool({
  name: "context",
  description: "Read invocation context",
  parameters: Type.Object({}),
  execute: async (_args, api, context) => ({
    output: [{ type: "text", text: JSON.stringify({ session: await sessionIdOf(api, context), cwd: api.env?.cwd }) }],
  }),
});`,
    );
    const manifest = join(dir, "release.json");
    await writeFile(manifest, JSON.stringify({ version: 1, id: "one", agent: "reviewer" }));
    await mkdir(join(root, ".secrets"), { recursive: true });
    const rotated = JSON.stringify({ openai: { type: "api_key", key: "rotated" } });
    await writeFile(join(root, ".secrets/auth.json"), rotated);
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (
        key.startsWith("FASTAGENT_") ||
        key === "MISE_DATA_DIR" ||
        ["https_proxy", "http_proxy", "all_proxy"].includes(key.toLowerCase())
      )
        delete env[key];
    }
    const bin = join(dir, "bin");
    const attempts = join(dir, "install-attempts");
    await mkdir(bin);
    await writeFile(
      join(bin, "npm"),
      `#!/bin/sh
mkdir -p node_modules/.bin
printf installed > node_modules/.bin/fastagent
if [ -f "$INSTALL_ATTEMPTS" ]; then
  printf 'retry\\n' >> "$INSTALL_ATTEMPTS"
else
  printf 'failed\\n' > "$INSTALL_ATTEMPTS"
  echo 'injected install failure' >&2
  exit 1
fi
`,
      { mode: 0o755 },
    );
    Object.assign(env, {
      PATH: `${bin}:${env.PATH}`,
      INSTALL_ATTEMPTS: attempts,
      FASTAGENT_RELEASE_FILE: manifest,
      FASTAGENT_STORAGE_DIR: root,
    });
    const workspaceUrl = pathToFileURL(join(packageDir, "dist/deploy/workspace.js")).href;
    const startUrl = pathToFileURL(join(packageDir, "dist/cli/commands/start.js")).href;
    // Native Node resolution is essential: a test loader can deduplicate the two package installations.
    const script = `
import { mock } from "node:test";
import { strict as assert } from "node:assert";
const storage = await import(${JSON.stringify(`${workspaceUrl}?actual`)});
mock.module(${JSON.stringify(workspaceUrl)}, { namedExports: { ...storage,
  prepareDeployment: (source, root, release) => storage.applyDeploymentRelease(source, root, release)
} });
const { openStartService } = await import(${JSON.stringify(startUrl)});
if (process.argv[1] === "fail") {
  await assert.rejects(openStartService(${JSON.stringify(agent)}, { input: false }), /dependency install failed/);
} else {
const service = await openStartService(${JSON.stringify(agent)}, { input: false });
try {
  const created = await service.agent.sessions.create();
  const end = await service.agent.messages.send({ sessionId: created.id, content: "Read my context" }, { wait: 60 });
  const page = await service.agent.sessions.entries(created.id);
  // Where \`prepareStartWorkspace\` pointed the machinery: the storage, beside the replaced definition.
  const { realpathSync } = await import("node:fs");
  console.log(JSON.stringify({ sessionId: created.id, end, entries: page.data, state: process.env.FASTAGENT_STATE_DIR, mise: process.env.MISE_DATA_DIR, content: realpathSync("content") }));
} finally {
  await service.close();
  await service.agent.close();
}
}
`;
    await exec(process.execPath, ["--experimental-test-module-mocks", "--input-type=module", "-e", script, "fail"], {
      env,
      timeout: CHILD_TIMEOUT_MS,
    });
    const out = await exec(
      process.execPath,
      ["--experimental-test-module-mocks", "--input-type=module", "-e", script],
      { env, timeout: CHILD_TIMEOUT_MS },
    );
    const reported = JSON.parse(out.stdout.trim().split("\n").at(-1)!) as {
      sessionId: string;
      end: { status: string };
      entries: { kind: string; data: unknown }[];
      state: string;
      mise: string;
      content: string;
    };
    // Every machinery dir lands on the storage, never in `definition/`, which each release replaces: a clone there
    // would take the agent's unpushed work with it. content/ is the storage's, through the link the release carries.
    expect(reported).toMatchObject({
      state: join(root, ".state"),
      // The tools the agent adds on the host: on the storage, so a new container still has them.
      mise: join(root, ".state", "mise"),
      content: join(await realpath(root), "content"),
    });
    expect(reported.end).toMatchObject({ status: "completed" });
    const result = JSON.stringify(reported.entries.find((entry) => entry.kind === "tool_result")?.data ?? "");
    // The tool knows the session it runs in.
    expect(result).toContain(reported.sessionId);
    // The tool's working directory is the deployed definition on the storage, not the image's copy.
    expect(result).toContain(`\\"cwd\\":\\"${join(root, "definition")}\\"`);
    expect(await readFile(join(root, ".secrets/auth.json"), "utf8")).toBe(rotated);
    expect(requests).toBe(2);
    expect(await readFile(attempts, "utf8")).toBe("failed\nretry\n");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);
