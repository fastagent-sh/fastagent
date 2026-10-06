/**
 * The definition carries its own `extensions/`: discovered as entry-point FILES with pi's own rules,
 * refused when they would not survive the trip into a container, and loaded both by `fastagent chat`
 * and by serving — where every bound session gets its own extension instances and no terminal.
 */
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { collect, createPiAgentFromDefinition, createPiAgentFromDir } from "../src/index.ts";
import { definitionServices } from "../src/engines/pi/agent-session-factory.ts";
import { agentModels } from "../src/engines/pi/agent-models.ts";
import { withModelRegistration } from "../src/engines/pi/models.ts";
import { registerAccountModels } from "../src/engines/pi/openai-account-models.ts";
import { assemblePiFromDefinition } from "../src/engines/pi/create.ts";
import { loadExtensionPaths } from "../src/engines/pi/definition.ts";
import { buildAgentSessionRuntime } from "../src/engines/pi/session-builder.ts";
import { log } from "../src/log.ts";
import { makeFaux, sentTools } from "./faux.ts";

/** An extension registering one tool whose presence proves the module was loaded and bound. */
const markerExtension = (toolName: string) => `
export default async function (api) {
  api.registerCommand("marker", {
    description: "proves a command was registered",
    handler: async () => {},
  });
  api.registerTool({
    name: ${JSON.stringify(toolName)},
    label: ${JSON.stringify(toolName)},
    description: "proves the extension loaded",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ output: "ok" }),
  });
}
`;

async function agentDirWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fa-ext-"));
  await writeFile(join(dir, "SYSTEM.md"), "You are terse.\n");
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
  }
  return dir;
}

describe("definition: one discovery of extensions/ for the catalog and the sessions", () => {
  it("sessions load the list the model catalog registered from", async () => {
    // A caller's ExecutionEnv may list a different directory than Node's filesystem: two discoveries could disagree on
    // which extension declared a model. The assembly takes the catalog's list instead of listing again.
    const dir = await agentDirWith({});
    const elsewhere = join(await agentDirWith({}), "elsewhere.ts");
    await writeFile(elsewhere, "export default () => {};\n");
    const { faux } = makeFaux();
    const models = agentModels(dir, {}, { providers: [faux.provider] });
    const { assembly } = await assemblePiFromDefinition(dir, {
      model: "faux/faux-1",
      models: { ...models, extensionPaths: async () => [elsewhere] },
    });
    expect(await assembly.extensionPaths()).toEqual([elsewhere]);
  });
});

describe("definition: extensions/ are live", () => {
  it("an edited extension, the module it imports, and an added one take effect on the next turn", async () => {
    // pi caches each extension's module per process; serving drops that cache when anything under extensions/
    // changed, and lists the directory again, so an agent that writes an extension uses it without a restart.
    const ext = (tool: string, withHelper = false) => `
${withHelper ? 'import { label } from "./lib/label.ts";' : ""}
export default async function (api) {
  api.registerTool({ name: ${JSON.stringify(tool)}, label: "t", description: ${withHelper ? "label" : '"d"'},
    parameters: { type: "object", properties: {} }, execute: async () => ({ output: "ok" }) });
}`;
    const dir = await agentDirWith({
      "extensions/a.ts": ext("tool_v1", true),
      "extensions/lib/label.ts": 'export const label = "LABEL_V1";\n',
    });
    const { faux } = makeFaux();
    const seen: { tools: string[]; label: string }[] = [];
    const reply = (context: Parameters<typeof sentTools>[0]) => {
      const sent = JSON.stringify(context);
      seen.push({
        tools: sentTools(context)
          .filter((name) => name.startsWith("tool_"))
          .sort(),
        label: sent.includes("LABEL_V2") ? "v2" : sent.includes("LABEL_V1") ? "v1" : "none",
      });
      return fauxAssistantMessage("ok");
    };
    faux.setResponses([reply, reply, reply, reply]);
    const { agent } = await createPiAgentFromDefinition(dir, { model: "faux/faux-1", providers: [faux.provider] });
    await collect(agent.invoke({ session: "s" }, { text: "1" }));
    await writeFile(join(dir, "extensions", "a.ts"), ext("tool_v2", true));
    await writeFile(join(dir, "extensions", "lib", "label.ts"), 'export const label = "LABEL_V2";\n');
    await collect(agent.invoke({ session: "s" }, { text: "2" }));
    await writeFile(join(dir, "extensions", "b.ts"), ext("tool_added"));
    // Two sessions bound at once after the edit: neither may load what the cache held before it.
    await Promise.all([
      collect(agent.invoke({ session: "s" }, { text: "3" })),
      collect(agent.invoke({ session: "t" }, { text: "3" })),
    ]);
    expect(seen).toEqual([
      { tools: ["tool_v1"], label: "v1" },
      { tools: ["tool_v2"], label: "v2" },
      { tools: ["tool_added", "tool_v2"], label: "v2" },
      { tools: ["tool_added", "tool_v2"], label: "v2" },
    ]);
  });
});

describe("definition: extensions/ discovery", () => {
  it("has no extensions when the directory is absent", async () => {
    const dir = await agentDirWith({});
    expect(await loadExtensionPaths(dir)).toEqual([]);
  });

  it("finds direct .ts/.js files and subdirectory index files, ignoring non-extension files", async () => {
    const dir = await agentDirWith({
      "extensions/alpha.ts": markerExtension("alpha"),
      "extensions/beta.js": markerExtension("beta"),
      "extensions/gamma/index.ts": markerExtension("gamma"),
      "extensions/README.md": "not an extension",
      "extensions/data.json": "{}",
    });

    expect(await loadExtensionPaths(dir)).toEqual([
      join(dir, "extensions", "alpha.ts"),
      join(dir, "extensions", "beta.js"),
      join(dir, "extensions", "gamma", "index.ts"),
    ]);
  });

  it("warns about a subdirectory with no index rather than skipping it silently", async () => {
    const dir = await agentDirWith({ "extensions/pkg/main.ts": markerExtension("pkg") });
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});

    expect(await loadExtensionPaths(dir)).toEqual([]);
    expect(warn.mock.calls.flat().join("\n")).toContain("expected index.ts or index.js");
    warn.mockRestore();
  });

  it("refuses a symlinked entry — a direct file or a subdirectory's index — and says why", async () => {
    // Neither would survive the trip into a container; the sibling beside it still loads.
    const outside = await mkdtemp(join(tmpdir(), "fa-ext-outside-"));
    await writeFile(join(outside, "escape.ts"), markerExtension("escape"));
    await writeFile(join(outside, "real.ts"), markerExtension("escape"));
    const dir = await agentDirWith({ "extensions/local.ts": markerExtension("local") });
    await symlink(join(outside, "escape.ts"), join(dir, "extensions", "escape.ts"));
    await mkdir(join(dir, "extensions", "pkg"), { recursive: true });
    await symlink(join(outside, "real.ts"), join(dir, "extensions", "pkg", "index.ts"));
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});

    expect(await loadExtensionPaths(dir)).toEqual([join(dir, "extensions", "local.ts")]);
    expect(warn.mock.calls.flat().join("\n")).toContain("is a symlink and will not be loaded");
    warn.mockRestore();
  });

  it("refuses an extensions/ symlinked outside the agent dir", async () => {
    const outside = await mkdtemp(join(tmpdir(), "fa-ext-outside-"));
    await writeFile(join(outside, "evil.ts"), markerExtension("evil"));
    const dir = await agentDirWith({});
    await symlink(outside, join(dir, "extensions"), "dir");

    await expect(loadExtensionPaths(dir)).rejects.toThrow(/resolves outside the agent dir/);
  });
});

describe("definition: serving runs extensions, one instance per session, with no UI", () => {
  /** Answers every turn with the text of its last user-side message, so a test can see what reached the model. */
  function echoFaux(offered?: string[][]) {
    const { faux } = makeFaux();
    faux.setResponses(
      Array.from({ length: 10 }, () => (context: Parameters<typeof sentTools>[0]) => {
        offered?.push(sentTools(context));
        const last = context.messages.filter((m) => m.role === "user").at(-1);
        return fauxAssistantMessage(`echo ${JSON.stringify(last?.content)}`);
      }),
    );
    return faux;
  }

  async function servedAgent(files: Record<string, string>, offered?: string[][]) {
    const dir = await agentDirWith(files);
    const faux = echoFaux(offered);
    const { agent } = await createPiAgentFromDefinition(dir, { model: "faux/faux-1", providers: [faux.provider] });
    return agent;
  }

  /** Every lifecycle moment an extension can observe, recorded under a per-test global. */
  const probe = (key: string) => `
const log = (globalThis[${JSON.stringify(key)}] ??= []);
export default function (pi) {
  const id = log.filter((l) => l.startsWith("factory")).length + 1;
  log.push("factory " + id);
  pi.on("session_start", (_e, ctx) => {
    ctx.ui.theme.fg("accent", "x"); // pi's global theme must be initialized without a TUI
    log.push("start " + id + " hasUI=" + ctx.hasUI);
  });
  pi.on("before_agent_start", (_e, ctx) => {
    if (!ctx.cwd || !ctx.sessionManager || !ctx.modelRegistry || !ctx.model) throw new Error("missing headless context");
    log.push("before " + id + " hasUI=" + ctx.hasUI);
  });
  pi.on("session_shutdown", () => log.push("shutdown " + id));
  pi.registerTool({
    name: "probe_tool", label: "p", description: "d",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ output: "ok" }),
  });
  pi.registerCommand("go", { description: "", handler: async (args) => pi.sendUserMessage("from command " + args) });
  pi.registerCommand("tag", { description: "", handler: async () => pi.appendEntry("tag", { v: 1 }) });
  pi.registerCommand("boom", { description: "", handler: async () => { throw new Error("command blew up"); } });
  pi.registerCommand("new", { description: "", handler: async (_a, ctx) => { await ctx.newSession(); } });
  pi.registerCommand("provider", { description: "", handler: async () => pi.registerProvider("x", { baseUrl: "https://x.invalid" }) });
}
`;
  const logOf = (key: string) => (globalThis as unknown as Record<string, string[]>)[key] ?? [];
  let n = 0;
  const freshKey = () => `__fa_ext_probe_${Date.now()}_${n++}__`;

  it("offers an extension's tool, starts it headless, and shuts it down when the invoke ends", async () => {
    const key = freshKey();
    const offered: string[][] = [];
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const agent = await servedAgent({ "extensions/probe.ts": probe(key) }, offered);
    await collect(agent.invoke({ session: "s" }, { text: "hi" }));
    await collect(agent.invoke({ session: "s" }, { text: "again" }));

    expect(offered[0]).toContain("probe_tool");
    expect(logOf(key)).toEqual([
      "factory 1", // unbound catalog registration
      "factory 2",
      "start 2 hasUI=false",
      "before 2 hasUI=false",
      "shutdown 2",
      "factory 3",
      "start 3 hasUI=false",
      "before 3 hasUI=false",
      "shutdown 3",
    ]);
    expect(warn.mock.calls.flat().join("\n")).not.toMatch(/failed/);
    warn.mockRestore();
  });

  it("runs the turn a command starts, in the command's own session, even when sessions run concurrently", async () => {
    const agent = await servedAgent({ "extensions/probe.ts": probe(freshKey()) });
    const [a, b] = await Promise.all([
      collect(agent.invoke({ session: "a" }, { text: "/go A" })),
      collect(agent.invoke({ session: "b" }, { text: "/go B" })),
    ]);
    expect(a.text).toContain("from command A");
    expect(b.text).toContain("from command B");
  });

  it("streams a command's turn even when the turn is slow to begin", async () => {
    // pi returns from the command before the turn it started is running; an async `before_agent_start` widens that
    // gap past any microtask ordering, so only waiting on the turn itself gets the answer.
    const agent = await servedAgent({
      "extensions/slow.ts": `
import { setTimeout } from "node:timers/promises";
export default function (pi) {
  pi.on("before_agent_start", async () => { await setTimeout(20); });
  pi.registerCommand("go", { description: "", handler: async (args) => pi.sendUserMessage("from command " + args) });
}
`,
    });
    expect((await collect(agent.invoke({ session: "s" }, { text: "/go slow" }))).text).toContain("from command slow");
  });

  it("refreshes distinct session-local runtimes for successive bindings", async () => {
    const agent = await servedAgent({ "extensions/probe.ts": probe(freshKey()) });
    await collect(agent.invoke({ session: "s" }, { text: "first" }));
    const refresh = vi.spyOn(ModelRuntime.prototype, "refresh");
    await collect(agent.invoke({ session: "s" }, { text: "second" }));
    await collect(agent.invoke({ session: "s" }, { text: "third" }));
    expect(new Set(refresh.mock.contexts).size).toBe(2);
    refresh.mockRestore();
  });

  it("completes a command that does its work without a model turn", async () => {
    const agent = await servedAgent({ "extensions/probe.ts": probe(freshKey()) });
    expect(await collect(agent.invoke({ session: "s" }, { text: "/tag" }))).toEqual({ text: "", data: undefined });
  });

  it("fails the invoke with the error of a command that throws", async () => {
    const agent = await servedAgent({ "extensions/probe.ts": probe(freshKey()) });
    await expect(collect(agent.invoke({ session: "s" }, { text: "/boom" }))).rejects.toThrow(/command blew up/);
  });

  it("refuses a command's session replacement instead of reporting it done", async () => {
    const agent = await servedAgent({ "extensions/probe.ts": probe(freshKey()) });
    await expect(collect(agent.invoke({ session: "s" }, { text: "/new" }))).rejects.toThrow(
      /ctx\.newSession\(\) is not available when serving/,
    );
  });

  it("accepts a provider registered after loading on the session-local runtime", async () => {
    const agent = await servedAgent({ "extensions/probe.ts": probe(freshKey()) });
    expect(await collect(agent.invoke({ session: "s" }, { text: "/provider" }))).toEqual({ text: "", data: undefined });
  });

  it("says once per process what pi warned about while loading: an extension tool replacing a built-in", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      const agent = await servedAgent({
        "extensions/search.ts": `export default (pi) => pi.registerTool({ name: "tool_search", label: "s", description: "mine", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [], details: undefined }) });`,
      });
      await collect(agent.invoke({ session: "a" }, { text: "hi" }));
      await collect(agent.invoke({ session: "b" }, { text: "hi" }));
      const said = warn.mock.calls
        .flat()
        .filter((line) =>
          /search\.ts registers tool `tool_search`, so built-in extension `tool-search` was not loaded/.test(
            String(line),
          ),
        );
      expect(said).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps extensions that register providers while loading", async () => {
    const offered: string[][] = [];
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const agent = await servedAgent(
      {
        "extensions/provider.ts": `
export default function (pi) {
  pi.registerProvider("acme", { baseUrl: "https://acme.invalid" });
  pi.registerTool({ name: "acme_tool", label: "a", description: "d", parameters: { type: "object", properties: {} }, execute: async () => ({ output: "ok" }) });
}
`,
        "extensions/marker.ts": markerExtension("marker_tool"),
      },
      offered,
    );
    await collect(agent.invoke({ session: "s" }, { text: "hi" }));

    expect(offered[0]).toContain("marker_tool");
    expect(offered[0]).toContain("acme_tool");
    expect(warn.mock.calls.flat().join("\n")).not.toMatch(/provider\.ts failed to load/);
    warn.mockRestore();
  });
});

describe("definition: the served `/` menu lists what sessions load", () => {
  it("lists an extension added while serving, as the next session loads it", async () => {
    // The menu and the session read one listing of `extensions/`, taken again for each: a menu that offered what a
    // session would not load would send `/late` to the model as plain text, and one that lagged would hide it.
    const dir = await agentDirWith({
      "fastagent.config.ts": 'export default { model: "mygw/m1" };\n',
      "models.json": JSON.stringify({
        providers: {
          mygw: { baseUrl: "http://gw.invalid/v1", api: "openai-completions", apiKey: "k", models: [{ id: "m1" }] },
        },
      }),
      "extensions/early.ts": 'export default (pi) => pi.registerCommand("early", { handler: async () => {} });\n',
    });
    const { sessionControl } = await createPiAgentFromDir(dir, { serving: true });
    await writeFile(
      join(dir, "extensions", "late.ts"),
      'export default (pi) => pi.registerCommand("late", { handler: async () => {} });\n',
    );
    const names = (await sessionControl?.commands())?.filter((c) => c.source === "extension").map((c) => c.name);
    expect(names).toEqual(["early", "late"]);
  });

  it("lists an edited extension's commands as the next session registers them, not the cached ones", async () => {
    // The menu asks the same "is the cached code current" the sessions ask: a renamed command must not linger in the
    // menu, where sending it would reach the model as plain text.
    const dir = await agentDirWith({
      "fastagent.config.ts": 'export default { model: "mygw/m1" };\n',
      "models.json": JSON.stringify({
        providers: {
          mygw: { baseUrl: "http://gw.invalid/v1", api: "openai-completions", apiKey: "k", models: [{ id: "m1" }] },
        },
      }),
      "extensions/early.ts": 'export default (pi) => pi.registerCommand("early", { handler: async () => {} });\n',
    });
    const { sessionControl } = await createPiAgentFromDir(dir, { serving: true });
    const names = async () =>
      (await sessionControl?.commands())?.filter((c) => c.source === "extension").map((c) => c.name);
    expect(await names()).toEqual(["early"]);
    await writeFile(
      join(dir, "extensions", "early.ts"),
      'export default (pi) => pi.registerCommand("renamed", { handler: async () => {} });\n',
    );
    expect(await names()).toEqual(["renamed"]);
  });
});

describe("definition: chat runs the definition's extensions in full", () => {
  it("mounts an extension-registered tool on the resident chat session", async () => {
    // The chat placement: the agent dir is `<workspace>/fastagent/`, entered from the inside.
    const workspace = await mkdtemp(join(tmpdir(), "fa-chat-ext-"));
    const dir = join(workspace, "fastagent");
    await mkdir(join(dir, "extensions"), { recursive: true });
    await writeFile(join(dir, "SYSTEM.md"), "You are terse.\n");
    await writeFile(join(dir, "fastagent.config.ts"), 'export default { model: "openai-codex/gpt-5.5" };\n');
    await writeFile(join(dir, "extensions", "marker.ts"), markerExtension("chat_extension_marker"));

    const rt = await buildAgentSessionRuntime(dir, {}, SessionManager.inMemory());
    try {
      expect(rt.session.getAllTools().map((t) => t.name)).toContain("chat_extension_marker");
    } finally {
      await rt.dispose?.();
    }
  });
});

describe("definition: extensions/ discovery only complains about real candidates", () => {
  it("announces every symlink, including a directory-shaped one with a dotted name", async () => {
    const dir = await agentDirWith({ "extensions/real.ts": markerExtension("real") });
    const outside = await mkdtemp(join(tmpdir(), "fa-nonmod-"));
    await writeFile(join(outside, "index.ts"), markerExtension("linked"));
    // `audit.ext -> dir` is a directory candidate to pi, and from a listing it is indistinguishable
    // from a symlinked data file. Guessing by name would drop this one in silence.
    await symlink(outside, join(dir, "extensions", "audit.ext"), "dir");
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});

    expect(await loadExtensionPaths(dir)).toHaveLength(1); // only the real one
    expect(warn.mock.calls.flat().join("\n")).toMatch(/audit\.ext is a symlink/);
    warn.mockRestore();
  });

  it("does not claim a directory lacks an index when its index was refused as a symlink", async () => {
    const dir = await agentDirWith({});
    await mkdir(join(dir, "extensions", "audit"), { recursive: true });
    const outside = await mkdtemp(join(tmpdir(), "fa-idx-"));
    await writeFile(join(outside, "index.ts"), markerExtension("audit"));
    await symlink(join(outside, "index.ts"), join(dir, "extensions", "audit", "index.ts"));
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});

    expect(await loadExtensionPaths(dir)).toHaveLength(0);
    const warnings = warn.mock.calls.flat().join("\n");
    expect(warnings).toMatch(/symlink/i); // the real reason
    expect(warnings).not.toMatch(/expected index\.ts/); // not a contradicting second story
    warn.mockRestore();
  });
});

describe("definition: chat brings extensions to life, not just into memory", () => {
  /** Registers at import time AND from session_start — pi supports both; only one used to survive. */
  const twoMoments = `
export default async function (pi) {
  pi.registerTool({
    name: "at_load", label: "a", description: "d",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ output: "ok" }),
  });
  pi.on("session_start", async () => {
    pi.registerTool({
      name: "at_session_start", label: "b", description: "d",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ output: "ok" }),
    });
  });
}
`;

  async function runtimeFor(files: Record<string, string>): Promise<unknown> {
    const workspace = await mkdtemp(join(tmpdir(), "fa-chat-live-"));
    const dir = join(workspace, "fastagent");
    await mkdir(join(dir, "extensions"), { recursive: true });
    await writeFile(join(dir, "SYSTEM.md"), "You are terse.\n");
    await writeFile(join(dir, "fastagent.config.ts"), 'export default { model: "openai-codex/gpt-5.5" };\n');
    for (const [rel, content] of Object.entries(files)) await writeFile(join(dir, rel), content);
    const rt = await buildAgentSessionRuntime(dir, {}, SessionManager.inMemory());
    await rt.dispose?.();
    return rt.session;
  }

  async function chatToolNames(files: Record<string, string>): Promise<string[]> {
    const workspace = await mkdtemp(join(tmpdir(), "fa-chat-live-"));
    const dir = join(workspace, "fastagent");
    await mkdir(join(dir, "extensions"), { recursive: true });
    await writeFile(join(dir, "SYSTEM.md"), "You are terse.\n");
    await writeFile(join(dir, "fastagent.config.ts"), 'export default { model: "openai-codex/gpt-5.5" };\n');
    for (const [rel, content] of Object.entries(files)) await writeFile(join(dir, rel), content);
    const rt = await buildAgentSessionRuntime(dir, {}, SessionManager.inMemory());
    try {
      return rt.session.getAllTools().map((t) => t.name);
    } finally {
      await rt.dispose?.();
    }
  }

  it("does not freeze the tool set, so a host-bound session_start can still add to it", async () => {
    // The tool NAMES are not allow-listed. pi lets an extension register from session_start, a
    // command or any handler, and those names cannot be in a build-time snapshot — an allowlist
    // would have refreshTools() filter them straight back out.
    //
    // session_start itself is emitted by the HOST (InteractiveMode.bindCurrentSessionExtensions),
    // which is why this asserts the absence of the freeze rather than the arrival of a late tool:
    // buildAgentSessionRuntime is the assembly, not the host, and a test that bound extensions
    // itself would be testing its own call.
    const names = await chatToolNames({ "extensions/two.ts": twoMoments });
    expect(names).toContain("at_load");
    const session = (await runtimeFor({ "extensions/two.ts": twoMoments })) as unknown as {
      _allowedToolNames?: Set<string>;
    };
    expect(session._allowedToolNames).toBeUndefined();
  });

  it("uses fastagent's own read tool, not pi's copy of it", async () => {
    // fastagent's `read` is createReadTool({ imageProcessor }) (create.ts). Chat used to allow-list
    // the NAME "read", which mounted pi's own — silently dropping image reading in chat only.
    const names = await chatToolNames({});
    expect(names).toContain("read");
    expect(names.filter((n) => n === "read")).toHaveLength(1); // and exactly one of them
  });
});

describe("definition: an extension can define the model chat runs on", () => {
  it("the catalog follows an edited extension's models, as the next session would run them", async () => {
    // What the control plane lists and lets a session select is the catalog; a model an edited extension now
    // declares must be in it, and one it no longer declares must not.
    const provider = (id: string) =>
      `export default pi => pi.registerProvider("acme", { baseUrl: "https://acme.invalid", api: "openai-completions", apiKey: "test", models: [{ id: ${JSON.stringify(id)}, name: "m", contextWindow: 1000, maxTokens: 100 }] });`;
    const dir = await agentDirWith({ "extensions/provider.ts": provider("first") });
    const models = agentModels(dir);
    const ids = async () =>
      (await models.runtime())
        .getProvider("acme")
        ?.getModels()
        .map((m) => m.id);
    expect(await ids()).toEqual(["first"]);
    await writeFile(join(dir, "extensions", "provider.ts"), provider("second"));
    expect(await ids()).toEqual(["second"]);
    // Another reader over the same directory in this process (an embedder's `availableModelsFromDir`): pi's cache is
    // per process, so its first load must not take the code cached before the edit either.
    await writeFile(join(dir, "extensions", "provider.ts"), provider("third"));
    expect(
      (await agentModels(dir).runtime())
        .getProvider("acme")
        ?.getModels()
        .map((m) => m.id),
    ).toEqual(["third"]);
  });

  it("the control plane follows it too, from the first read after the edit: models, the default, validation", async () => {
    const provider = (id: string) =>
      `export default pi => pi.registerProvider("acme", { baseUrl: "https://acme.invalid", api: "openai-completions", apiKey: "test", models: [{ id: ${JSON.stringify(id)}, name: "m", contextWindow: 1000, maxTokens: 100 }] });`;
    const dir = await agentDirWith({
      "fastagent.config.ts": 'export default { model: "acme/first" };\n',
      "extensions/provider.ts": provider("first"),
    });
    const { sessionControl } = await createPiAgentFromDir(dir, { sessionControl: true });
    const allowed = async () =>
      (await sessionControl!.models()).map((m) => m.spec).filter((spec) => spec.startsWith("acme/"));
    expect(await allowed()).toEqual(["acme/first"]);
    expect((await sessionControl!.sessions.get("s").state()).model).toBe("acme/first");
    await writeFile(join(dir, "extensions", "provider.ts"), provider("second"));
    // No turn, no menu read first: the plane resolves through the same function a turn would, at each call.
    expect(await allowed()).toEqual(["acme/second"]);
    // The configured default is gone from the registry, so state() reports no model (and a turn would fail on it).
    // Said once, not by every read that meets it again.
    const warns = vi.spyOn(log, "warn").mockImplementation(() => {});
    const defaultGone = () => warns.mock.calls.filter(([m]) => /configured default model does not resolve/.test(m));
    try {
      expect((await sessionControl!.sessions.get("s").state()).model).toBeUndefined();
      expect((await sessionControl!.sessions.get("t").state()).model).toBeUndefined();
      expect(await sessionControl!.sessions.get("s").update({ name: "n" })).toEqual({ ok: true });
      expect(defaultGone()).toHaveLength(1);
      expect(await sessionControl!.sessions.get("s").update({ model: "acme/second" })).toEqual({ ok: true });
      expect((await sessionControl!.sessions.get("s").update({ model: "acme/first" })).ok).toBe(false);

      // A registry that cannot be built now (extensions/ unreadable): state() stays TOTAL and reports no model, said
      // once; models() rejects, since [] would say the model is not updatable.
      await chmod(join(dir, "extensions"), 0o000);
      try {
        const state = await sessionControl!.sessions.get("t").state();
        expect(state.status).toBe("idle");
        expect(state.model).toBeUndefined();
        await sessionControl!.sessions.get("t").state();
        expect(warns.mock.calls.filter(([m]) => /model registry cannot be built/.test(m))).toHaveLength(1);
        await expect(sessionControl!.models()).rejects.toThrow(/EACCES/);
      } finally {
        await chmod(join(dir, "extensions"), 0o755);
      }
      await writeFile(join(dir, "extensions", "provider.ts"), provider("first"));
      expect((await sessionControl!.sessions.get("t").state()).model).toBe("acme/first");
    } finally {
      warns.mockRestore();
    }
  });

  it("joins registration refreshes even when the SDK's final refresh finishes first", async () => {
    const dir = await agentDirWith({
      "extensions/provider.ts": `export default pi => pi.registerProvider("acme", { baseUrl: "https://acme.invalid", api: "openai-completions", apiKey: "test", models: [{ id: "test", name: "test", contextWindow: 1000, maxTokens: 100 }] });`,
    });
    const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
    // As fastagent builds every runtime (createPiModelRuntime): `openai` already wrapped, so loading the definition
    // registers nothing of ours and the refreshes counted below are the extension's and the SDK's.
    await withModelRegistration(runtime, async () => registerAccountModels(runtime));
    const nativeRefresh = runtime.refresh.bind(runtime);
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const refresh = vi.spyOn(runtime, "refresh").mockImplementation(async (options) => {
      if (calls++ === 0) await blocked;
      return nativeRefresh(options);
    });
    let ready = false;
    const loaded = definitionServices({
      cwd: dir,
      modelRuntime: runtime,
      definition: { skills: [] },
      extensionPaths: [join(dir, "extensions/provider.ts")],
    }).then((services) => {
      ready = true;
      return services;
    });
    try {
      await vi.waitFor(() => expect(calls).toBe(2));
      await refresh.mock.results[1]?.value;
      await setImmediate();
      expect(ready).toBe(false);
    } finally {
      release();
      await loaded;
      refresh.mockRestore();
    }
    expect(runtime.hasConfiguredAuth("acme")).toBe(true);
  });
  it("resolves a model registered by an extension's registerProvider()", async () => {
    // pi documents registerProvider() as the way an extension adds providers/models, and extensions
    // only execute when the services are built. Resolving the configured model before that failed
    // with a bare "unknown model" — and probed auth for a provider that did not exist yet.
    const workspace = await mkdtemp(join(tmpdir(), "fa-prov-"));
    const dir = join(workspace, "fastagent");
    await mkdir(join(dir, "extensions"), { recursive: true });
    await writeFile(join(dir, "SYSTEM.md"), "You are terse.\n");
    await writeFile(join(dir, "fastagent.config.ts"), 'export default { model: "acme-proxy/acme-1" };\n');
    await writeFile(
      join(dir, "extensions", "provider.ts"),
      `
export default async function (pi) {
  pi.registerProvider("acme-proxy", {
    baseUrl: "https://proxy.example.com",
    apiKey: "$ACME_KEY",
    api: "anthropic-messages",
    models: [{
      id: "acme-1",
      name: "Acme 1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 16384,
    }],
  });
}
`,
    );

    const rt = await buildAgentSessionRuntime(dir, {}, SessionManager.inMemory());
    try {
      expect(rt.session.model?.id).toBe("acme-1");
    } finally {
      await rt.dispose?.();
    }
  });
});

describe("definition: chat rebuilds extensions when pi replaces the session", () => {
  it("re-runs the extension factory on newSession(), not once for the runtime", async () => {
    // pi replaces the session on /new, /resume and fork, and its extension contract is that the
    // replacement gets freshly loaded extensions. The assembly is memoized (prompt, tools and
    // definition all are); memoizing the services with it would carry one session's extension
    // objects into the next. Driving runtime.newSession() is the only way to prove that — two
    // separate runtimes would each load once and pass either way.
    const key = `__fa_ext_rebuild_on_new_${Date.now()}__`;
    const workspace = await mkdtemp(join(tmpdir(), "fa-newsess-"));
    const dir = join(workspace, "fastagent");
    await mkdir(join(dir, "extensions"), { recursive: true });
    await writeFile(join(dir, "SYSTEM.md"), "You are terse.\n");
    await writeFile(join(dir, "fastagent.config.ts"), 'export default { model: "openai-codex/gpt-5.5" };\n');
    await writeFile(
      join(dir, "extensions", "count.ts"),
      `
export default async function (pi) {
  const k = ${JSON.stringify(key)};
  globalThis[k] = (globalThis[k] ?? 0) + 1;
}
`,
    );

    const rt = await buildAgentSessionRuntime(dir, {}, SessionManager.inMemory());
    try {
      const counts = globalThis as unknown as Record<string, number>;
      const afterBuild = counts[key] ?? 0;
      expect(afterBuild).toBeGreaterThan(0);
      const { cancelled } = await rt.newSession();
      expect(cancelled).toBe(false);
      expect(counts[key]).toBeGreaterThan(afterBuild);
    } finally {
      await rt.dispose?.();
    }
  });
});
