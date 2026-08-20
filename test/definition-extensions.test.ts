/**
 * The definition carries its own `extensions/`: discovered as entry-point FILES, handed to pi as
 * `additionalExtensionPaths`, and reaching the model through the SERVING path — while pi's
 * machine-global discovery stays suppressed.
 */
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { collect, createPiAgentFromDefinition } from "../src/index.ts";
import { loadExtensionPaths } from "../src/engines/pi/definition.ts";
import { buildAgentSessionRuntime } from "../src/engines/pi/session-builder.ts";
import { log } from "../src/log.ts";
import { makeFaux } from "./faux.ts";

/** An extension registering one tool whose presence proves the module was loaded and bound. */
const markerExtension = (toolName: string) => `
export default async function (api) {
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

  it("refuses a symlinked entry, which would not survive the trip into a container", async () => {
    const outside = await mkdtemp(join(tmpdir(), "fa-ext-outside-"));
    await writeFile(join(outside, "escape.ts"), markerExtension("escape"));
    const dir = await agentDirWith({ "extensions/local.ts": markerExtension("local") });
    await symlink(join(outside, "escape.ts"), join(dir, "extensions", "escape.ts"));
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});

    expect(await loadExtensionPaths(dir)).toEqual([join(dir, "extensions", "local.ts")]);
    expect(warn.mock.calls.flat().join("\n")).toContain("is a symlink and will not be loaded");
    warn.mockRestore();
  });

  it("refuses a subdirectory whose index.ts is a symlink out of the definition", async () => {
    const outside = await mkdtemp(join(tmpdir(), "fa-ext-outside-"));
    await writeFile(join(outside, "real.ts"), markerExtension("escape"));
    const dir = await agentDirWith({ "extensions/keep.ts": markerExtension("keep") });
    await mkdir(join(dir, "extensions", "pkg"), { recursive: true });
    await symlink(join(outside, "real.ts"), join(dir, "extensions", "pkg", "index.ts"));
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});

    expect(await loadExtensionPaths(dir)).toEqual([join(dir, "extensions", "keep.ts")]);
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

describe("definition: extensions reach the served agent", () => {
  /** Build a served agent on a faux model and report the tool names the model was offered. */
  async function toolNamesOfferedBy(dir: string): Promise<string[]> {
    const { faux } = makeFaux();
    let offered: string[] = [];
    faux.setResponses([
      (context) => {
        offered = (context.tools ?? []).map((t) => t.name);
        return fauxAssistantMessage("ok");
      },
    ]);
    const { agent } = await createPiAgentFromDefinition(dir, {
      model: "faux/faux-1",
      providers: [faux.provider],
    });
    await collect(agent.invoke({ session: "s" }, { text: "hi" }));
    return offered;
  }

  it("an extension-registered tool is offered to the model on the serving path", async () => {
    const dir = await agentDirWith({ "extensions/marker.ts": markerExtension("extension_marker") });
    expect(await toolNamesOfferedBy(dir)).toContain("extension_marker");
  });

  it("a broken extension is warned about, not swallowed, and the agent still serves", async () => {
    const dir = await agentDirWith({ "extensions/broken.ts": "throw new Error('boom at import');\n" });
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});

    const offered = await toolNamesOfferedBy(dir);

    expect(warn.mock.calls.flat().join("\n")).toMatch(/extension .*broken\.ts failed to load/);
    expect(offered.length).toBeGreaterThan(0); // the turn still ran
    warn.mockRestore();
  });
});

describe("definition: an extension that throws at runtime", () => {
  it("is warned about rather than dropped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-ext-"));
    await writeFile(join(dir, "persona.md"), "You are terse.\n");
    await mkdir(join(dir, "extensions"), { recursive: true });
    await writeFile(
      join(dir, "extensions", "boom.ts"),
      `export default async function (api) {
         api.on("session_start", () => { throw new Error("handler exploded"); });
       }\n`,
    );

    const { faux } = makeFaux();
    faux.setResponses([() => fauxAssistantMessage("ok")]);
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});

    const { agent } = await createPiAgentFromDefinition(dir, {
      model: "faux/faux-1",
      providers: [faux.provider],
    });
    await collect(agent.invoke({ session: "s" }, { text: "hi" }));

    expect(warn.mock.calls.flat().join("\n")).toMatch(/extension .*boom\.ts failed on session_start/);
    warn.mockRestore();
  });
});

describe("definition: extension discovery is assembly-time, not per turn", () => {
  it("does not repeat its warnings on every invoke", async () => {
    const dir = await agentDirWith({ "extensions/pkg/main.ts": markerExtension("pkg") });
    const { faux } = makeFaux();
    faux.setResponses([() => fauxAssistantMessage("one"), () => fauxAssistantMessage("two")]);
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});

    const { agent } = await createPiAgentFromDefinition(dir, {
      model: "faux/faux-1",
      providers: [faux.provider],
    });
    await collect(agent.invoke({ session: "s" }, { text: "hi" }));
    await collect(agent.invoke({ session: "s" }, { text: "again" }));

    const complaints = warn.mock.calls.flat().filter((c) => String(c).includes("expected index.ts"));
    expect(complaints).toHaveLength(1); // the boot scan, not one per turn
    warn.mockRestore();
  });
});

describe("definition: chat loads the same extensions serving does", () => {
  it("mounts an extension-registered tool on the resident chat session", async () => {
    // The chat placement: the agent dir is `<workspace>/fastagent/`, entered from the inside.
    const workspace = await mkdtemp(join(tmpdir(), "fa-chat-ext-"));
    const dir = join(workspace, "fastagent");
    await mkdir(join(dir, "extensions"), { recursive: true });
    await writeFile(join(dir, "persona.md"), "You are terse.\n");
    await writeFile(join(dir, "fastagent.config.mjs"), 'export default { model: "openai-codex/gpt-5.5" };\n');
    await writeFile(join(dir, "extensions", "marker.ts"), markerExtension("chat_extension_marker"));

    const rt = await buildAgentSessionRuntime(dir, {}, SessionManager.inMemory());
    try {
      expect(rt.session.getAllTools().map((t) => t.name)).toContain("chat_extension_marker");
    } finally {
      await rt.dispose?.();
    }
  });
});

describe("definition: extension lifecycle across per-invoke sessions", () => {
  it("two agents in one process get an instance each — the boundary is the assembly, not the process", async () => {
    const key = `__fa_ext_perassembly_${Date.now()}__`;
    const mk = async () =>
      await agentDirWith({
        "extensions/c.ts": `
export default async function (api) {
  const k = ${JSON.stringify(key)};
  globalThis[k] = (globalThis[k] ?? 0) + 1;
}
`,
      });
    const [d1, d2] = [await mk(), await mk()];
    const { faux } = makeFaux();
    faux.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage("ok")));
    const opts = { model: "faux/faux-1", providers: [faux.provider] };
    const a1 = (await createPiAgentFromDefinition(d1, opts)).agent;
    const a2 = (await createPiAgentFromDefinition(d2, opts)).agent;
    const g = globalThis as unknown as Record<string, number>;

    await collect(a1.invoke({ session: "s" }, { text: "1" }));
    expect(g[key]).toBe(1);
    await collect(a2.invoke({ session: "s" }, { text: "2" }));
    expect(g[key]).toBe(2); // a second agent loads its own
    await collect(a1.invoke({ session: "s" }, { text: "3" }));
    expect(g[key]).toBe(2); // and the first one keeps the instance it had
  });

  it("one extension instance serves every turn, and session_start repeats on each", async () => {
    const counterKey = `__fa_ext_lifecycle_${Date.now()}__`;
    const dir = await agentDirWith({
      "extensions/lifecycle.ts": `
export default async function (api) {
  const key = ${JSON.stringify(counterKey)};
  globalThis[key] ??= { start: 0, shutdown: 0, factories: 0 };
  globalThis[key].factories++;
  api.on("session_start", () => { globalThis[key].start++; });
  api.on("session_shutdown", () => { globalThis[key].shutdown++; });
}
`,
    });
    const { faux } = makeFaux();
    faux.setResponses([() => fauxAssistantMessage("one"), () => fauxAssistantMessage("two")]);

    const { agent } = await createPiAgentFromDefinition(dir, {
      model: "faux/faux-1",
      providers: [faux.provider],
    });
    await collect(agent.invoke({ session: "s" }, { text: "hi" }));
    await collect(agent.invoke({ session: "s" }, { text: "again" }));

    const counts = (globalThis as Record<string, unknown>)[counterKey] as {
      start: number;
      shutdown: number;
      factories: number;
    };
    // ONE instance for this agent: the extensions belong to the assembly's ResourceLoader, which
    // loads them once and serves every turn from that. A turn cannot be given its own copy.
    expect(counts.factories).toBe(1);
    // session_start still fires per turn, because a session must be bound for its errors to surface
    // at all — which is why the docs require start handlers to be idempotent.
    expect(counts.start).toBe(2);
    // No per-turn shutdown. Emitting one would tear down state the NEXT turn (or a concurrent one)
    // is still using, since they are all the same instance.
    expect(counts.shutdown).toBe(0);
  });
});

describe("extension lifecycle under concurrency", () => {
  /** Writes one line per lifecycle event into `<dir>/events.log`, from MODULE scope. */
  const lifecycleExtension = `
import { appendFileSync } from "node:fs";
import { join } from "node:path";
const logFile = join(import.meta.dirname, "..", "events.log");
let live = new Set();
export default async function (pi) {
  pi.on("session_start", async () => {
    const t = setInterval(() => {}, 1e6);
    live.add(t);
    appendFileSync(logFile, \`start live=\${live.size}\\n\`);
  });
  pi.on("session_shutdown", async () => {
    for (const t of live) clearInterval(t);
    appendFileSync(logFile, \`shutdown cleared=\${live.size}\\n\`);
    live.clear();
  });
}
`;

  it("a turn never tears down a resource another turn is using", async () => {
    const dir = await agentDirWith({ "extensions/lifecycle.ts": lifecycleExtension });
    const { faux } = makeFaux();
    let releaseA!: () => void;
    let aRunning!: () => void;
    const held = new Promise<void>((r) => (releaseA = r));
    const started = new Promise<void>((r) => (aRunning = r));
    faux.setResponses([
      async () => {
        aRunning();
        await held; // A's model call hangs, so A's session outlives B's entire turn
        return fauxAssistantMessage("a");
      },
      fauxAssistantMessage("b"),
    ]);
    const { agent } = await createPiAgentFromDefinition(dir, {
      model: `${faux.getModel().provider}/${faux.getModel().id}`,
      providers: [faux.provider],
    });

    const a = collect(agent.invoke({ session: "room-a" }, { text: "x" }));
    await started;
    await collect(agent.invoke({ session: "room-b" }, { text: "y" })); // B runs to completion inside A
    releaseA();
    await a;

    const events = (await readFile(join(dir, "events.log"), "utf8")).trim().split("\n");
    // The instance is shared (pi's module cache is process-global), so a per-turn shutdown would
    // clear the timer A is still using — B's cleanup destroying A's resource. Not emitting one is
    // what keeps concurrent turns from interfering.
    expect(events.filter((line) => line.startsWith("start"))).toHaveLength(2);
    expect(events.filter((line) => line.startsWith("shutdown"))).toHaveLength(0);
  });
});

describe("a definition edit rebuilds the extension instance", () => {
  it("editing persona.md re-runs the extension factory — pi's reload clears its module cache", async () => {
    const key = `__fa_ext_rebuild_${Date.now()}__`;
    const dir = await agentDirWith({
      "extensions/counter.ts": `
export default async function (api) {
  const k = ${JSON.stringify(key)};
  globalThis[k] = (globalThis[k] ?? 0) + 1;
}
`,
    });
    const { faux } = makeFaux();
    faux.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("ok")));
    const { agent } = await createPiAgentFromDefinition(dir, {
      model: "faux/faux-1",
      providers: [faux.provider],
    });

    await collect(agent.invoke({ session: "s" }, { text: "one" }));
    expect((globalThis as Record<string, unknown>)[key]).toBe(1);

    await collect(agent.invoke({ session: "s" }, { text: "two" }));
    expect((globalThis as Record<string, unknown>)[key]).toBe(1); // unchanged definition, same instance

    // The definition is LIVE, and pi only serves a re-read one after ResourceLoader.reload() — which
    // begins with clearExtensionCache(). Extensions are therefore rebuilt by an edit to persona.md,
    // even though nothing about the extension changed. There is no narrower reload in pi's API and
    // no session-level prompt setter, so this is a property to know, not a bug to fix here: state an
    // extension holds does not survive an edit to the definition.
    await writeFile(join(dir, "persona.md"), "You are extremely terse.\n");
    await collect(agent.invoke({ session: "s" }, { text: "three" }));
    expect((globalThis as Record<string, unknown>)[key]).toBe(2);
  });
});
