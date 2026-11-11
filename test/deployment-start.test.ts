import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { buildable } from "./cli-run.ts";
import { buildProject } from "../src/harnesses/pi-durable/build.ts";

// This test pays a project compile plus a cold harness start in a child process: ~3s on an idle machine, but a full
// `npm test` run puts a fork on every core and has been measured past the old 30s ceiling. The budget is raised, not
// the parallelism (vitest.config.ts states why). The child ceiling stays the tighter of the two so a hung child is
// reported as itself, not as an opaque test timeout.
const CHILD_TIMEOUT_MS = 45_000;

it("opens the image's program with the storage as the instance root, its credentials and the tool context kept", async () => {
  const repo = dirname(dirname(fileURLToPath(import.meta.url)));
  const dir = await mkdtemp(join(tmpdir(), "fa-deployment-start-"));
  const root = join(dir, "data"),
    agent = join(dir, "image", "definition"); // the image's baked definition
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
    await mkdir(agent, { recursive: true });
    await buildable(agent);
    // The packages the agent's own code imports, as its install would bring them.
    await symlink(join(repo, "node_modules/@earendil-works"), join(agent, "node_modules/@earendil-works"), "dir");
    // The agent's own FastAgent, installed as a package (a link to the source would be read by the build as the
    // project's own code): the one the image's CLI runs, and so the one its tools' `sessionIdOf` must be.
    const installed = join(agent, "node_modules/@fastagent-sh/fastagent");
    await rm(installed, { recursive: true });
    await mkdir(installed, { recursive: true });
    await writeFile(
      join(installed, "package.json"),
      '{"name":"@fastagent-sh/fastagent","type":"module","exports":"./index.js"}',
    );
    await writeFile(
      join(installed, "index.js"),
      `export * from ${JSON.stringify(pathToFileURL(join(repo, "src/index.ts")).href)};\n`,
    );
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    await writeFile(
      join(agent, "fastagent.config.ts"),
      `import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
const model = {
  id: "test", name: "Test", api: "openai-completions", provider: "local", baseUrl: ${JSON.stringify(baseUrl)},
  reasoning: false, input: ["text" as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32768, maxTokens: 1024,
};
export default {
  defaults: { model: "local/test" },
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
      `import { obj, str } from "@earendil-works/pi-schema";
import { defineTool } from "@earendil-works/pi-durable";
import { sessionIdOf } from "@fastagent-sh/fastagent";
export default defineTool({
  name: "context",
  description: "Read invocation context",
  parameters: obj({}),
  execute: async (_args, api, context) => ({
    output: [{ type: "text", text: JSON.stringify({ session: await sessionIdOf(api, context), cwd: api.env?.cwd }) }],
  }),
});`,
    );
    // What the image does: it builds the definition, and the box opens that build where the image has it.
    await buildProject(agent);
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
    Object.assign(env, {
      // What a deploy sets on the box: the image holds none of it.
      FASTAGENT_RELEASE_ID: "one",
      FASTAGENT_NAME: "reviewer",
      FASTAGENT_CONFIG_JSON: JSON.stringify({ thinkingLevel: "high" }),
      FASTAGENT_ROOT: root,
    });
    const workspaceUrl = pathToFileURL(join(repo, "src/deploy/workspace.ts")).href;
    const startUrl = pathToFileURL(join(repo, "src/cli/commands/start.ts")).href;
    // A test machine has no mount to take: the storage is claimed as on a box, without the mount and the lease.
    const script = `
const storage = await import(${JSON.stringify(`${workspaceUrl}?actual`)});
const { mock } = await import("node:test");
mock.module(${JSON.stringify(workspaceUrl)}, { namedExports: { ...storage,
  prepareDeployment: (root, release) => storage.claimDeploymentStorage(root, release)
} });
const { openStartService } = await import(${JSON.stringify(startUrl)});
const service = await openStartService(${JSON.stringify(agent)}, { input: false });
try {
  const created = await service.agent.sessions.create();
  const end = await service.agent.messages.send({ sessionId: created.id, content: "Read my context" }, { wait: 60 });
  const page = await service.agent.sessions.entries(created.id);
  console.log(JSON.stringify({ sessionId: created.id, end, entries: page.data, state: process.env.FASTAGENT_STATE_DIR, mise: process.env.MISE_DATA_DIR, thinking: service.config.thinkingLevel, thinkingFrom: service.config.sources.thinkingLevel }));
} finally {
  await service.close();
  await service.agent.close();
}
`;
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
      thinking: string;
      thinkingFrom: string;
    };
    // Every machinery dir lands on the storage, the instance's root: nothing of the instance is written into the image.
    expect(reported).toMatchObject({
      state: join(root, ".state"),
      // The tools the agent adds on the host: on the storage, so a new container still has them.
      mise: join(root, ".state", "mise"),
      // Read from the configuration the deploy delivered as a variable.
      thinking: "high",
      thinkingFrom: "FASTAGENT_CONFIG_JSON",
    });
    expect(reported.end).toMatchObject({ status: "completed" });
    const result = JSON.stringify(reported.entries.find((entry) => entry.kind === "tool_result")?.data ?? "");
    // The tool knows the session it runs in.
    expect(result).toContain(reported.sessionId);
    // The tool's working directory is the storage, which every release keeps; the image holds only the program.
    expect(result).toContain(`\\"cwd\\":\\"${root}\\"`);
    expect(JSON.parse(await readFile(join(root, ".deployment", "applied.json"), "utf8"))).toMatchObject({
      id: "one",
      agent: "reviewer",
    });
    await expect(readFile(join(root, "definition", "SYSTEM.md"))).rejects.toThrow(/ENOENT/);
    expect(await readFile(join(root, ".secrets/auth.json"), "utf8")).toBe(rotated);
    expect(requests).toBe(2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);
