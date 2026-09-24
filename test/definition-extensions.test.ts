/**
 * The definition carries its own `extensions/`: discovered as entry-point FILES with pi's own rules,
 * refused when they would not survive the trip into a container, and loaded both by `fastagent chat`
 * and by serving — where every bound session gets its own extension instances and no terminal.
 */
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { collect, createPiAgentFromDefinition, createPiAgentFromDir } from "../src/index.ts";
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
  await writeFile(join(dir, "persona.md"), "You are terse.\n");
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
  }
  return dir;
}

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
      "factory 1",
      "start 1 hasUI=false",
      "shutdown 1",
      "factory 2",
      "start 2 hasUI=false",
      "shutdown 2",
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

  it("builds a session's loader without rebuilding the model runtime every conversation shares", async () => {
    const agent = await servedAgent({ "extensions/probe.ts": probe(freshKey()) });
    await collect(agent.invoke({ session: "s" }, { text: "first" }));
    const refresh = vi.spyOn(ModelRuntime.prototype, "refresh");
    await collect(agent.invoke({ session: "s" }, { text: "second" }));
    await collect(agent.invoke({ session: "s" }, { text: "third" }));
    expect(refresh).not.toHaveBeenCalled();
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

  it("refuses a provider registered after loading", async () => {
    const agent = await servedAgent({ "extensions/probe.ts": probe(freshKey()) });
    await expect(collect(agent.invoke({ session: "s" }, { text: "/provider" }))).rejects.toThrow(
      /cannot register model providers when serving/,
    );
  });

  it("leaves out, and names, an extension that registers a provider while loading", async () => {
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
    expect(offered[0]).not.toContain("acme_tool");
    expect(warn.mock.calls.flat().join("\n")).toMatch(/provider\.ts failed to load: extensions cannot register/);
    warn.mockRestore();
  });
});

describe("definition: the served `/` menu lists what sessions load", () => {
  it("lists the extensions discovered at startup, not ones added while serving", async () => {
    // A session loads the assembly's entry points, discovered once; `start` does not restart on an edit. A menu that
    // rescanned `extensions/` would offer `/late`, and sending it would reach the model as plain text.
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
    expect(names).toEqual(["early"]);
  });
});

describe("definition: chat runs the definition's extensions in full", () => {
  it("mounts an extension-registered tool on the resident chat session", async () => {
    // The chat placement: the agent dir is `<workspace>/fastagent/`, entered from the inside.
    const workspace = await mkdtemp(join(tmpdir(), "fa-chat-ext-"));
    const dir = join(workspace, "fastagent");
    await mkdir(join(dir, "extensions"), { recursive: true });
    await writeFile(join(dir, "persona.md"), "You are terse.\n");
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
    await writeFile(join(dir, "persona.md"), "You are terse.\n");
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
    await writeFile(join(dir, "persona.md"), "You are terse.\n");
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
  it("resolves a model registered by an extension's registerProvider()", async () => {
    // pi documents registerProvider() as the way an extension adds providers/models, and extensions
    // only execute when the services are built. Resolving the configured model before that failed
    // with a bare "unknown model" — and probed auth for a provider that did not exist yet.
    const workspace = await mkdtemp(join(tmpdir(), "fa-prov-"));
    const dir = join(workspace, "fastagent");
    await mkdir(join(dir, "extensions"), { recursive: true });
    await writeFile(join(dir, "persona.md"), "You are terse.\n");
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
    await writeFile(join(dir, "persona.md"), "You are terse.\n");
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
