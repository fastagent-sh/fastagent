/**
 * The definition carries its own `extensions/`: discovered as entry-point FILES, handed to pi as
 * `additionalExtensionPaths`, and reaching the model through the SERVING path — while pi's
 * machine-global discovery stays suppressed.
 */
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
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
  it("pairs every session_start with a session_shutdown", async () => {
    const counterKey = `__fa_ext_lifecycle_${Date.now()}__`;
    const dir = await agentDirWith({
      "extensions/lifecycle.ts": `
export default async function (api) {
  const key = ${JSON.stringify(counterKey)};
  globalThis[key] ??= { start: 0, shutdown: 0 };
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

    const counts = (globalThis as Record<string, unknown>)[counterKey] as { start: number; shutdown: number };
    expect(counts.start).toBe(2); // one session per invoke
    expect(counts.shutdown).toBe(counts.start); // and each one cleaned up
  });
});
