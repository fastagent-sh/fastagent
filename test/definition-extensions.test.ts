/**
 * The definition carries its own `extensions/`: discovered as entry-point FILES with pi's own rules,
 * refused when they would not survive the trip into a container, and loaded by `fastagent chat`.
 *
 * SERVING does not load them, and warns that it did not — pi's extension runtime is shared across
 * sessions, which a concurrent server cannot use safely. These tests pin both halves: discovery and
 * its refusals apply either way, tools reach the model in chat, and serving stays quiet-free about
 * skipping them.
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

describe("definition: serving does NOT run extensions, and says so", () => {
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

  it("does not offer an extension-registered tool to the model", async () => {
    // pi's extension runtime is shared across sessions (its own source calls it "the shared
    // runtime"), and serving runs concurrent turns for unrelated conversations. Loading them would
    // let one turn's `pi.sendMessage()` land in another conversation - a silent correctness bug,
    // which is worse than the missing feature. `chat` runs them fully; see the block below.
    const dir = await agentDirWith({ "extensions/marker.ts": markerExtension("extension_marker") });
    const offered = await toolNamesOfferedBy(dir);
    expect(offered).not.toContain("extension_marker");
    expect(offered.length).toBeGreaterThan(0); // the agent still serves, with its own tools
  });

  it("warns that they were skipped, rather than dropping them in silence", async () => {
    const dir = await agentDirWith({ "extensions/marker.ts": markerExtension("extension_marker") });
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    await toolNamesOfferedBy(dir);
    expect(warn.mock.calls.flat().join("\n")).toMatch(/NOT loaded when serving/);
    warn.mockRestore();
  });

  it("keeps refusing an extensions/ that escapes the agent dir", async () => {
    // Discovery keeps running even though serving does not load: the refusals are about what the
    // artifact may contain, and chat consumes the same list.
    const outside = await mkdtemp(join(tmpdir(), "fa-outside-"));
    await writeFile(join(outside, "eee.ts"), markerExtension("nope"));
    const dir = await agentDirWith({});
    await symlink(outside, join(dir, "extensions"), "dir");
    await expect(loadExtensionPaths(dir)).rejects.toThrow(/resolves outside the agent dir/);
  });
});

describe("definition: chat runs the definition's extensions in full", () => {
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
    await writeFile(join(dir, "fastagent.config.mjs"), 'export default { model: "openai-codex/gpt-5.5" };\n');
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
    await writeFile(join(dir, "fastagent.config.mjs"), 'export default { model: "openai-codex/gpt-5.5" };\n');
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
    await writeFile(join(dir, "fastagent.config.mjs"), 'export default { model: "acme-proxy/acme-1" };\n');
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
    await writeFile(join(dir, "fastagent.config.mjs"), 'export default { model: "openai-codex/gpt-5.5" };\n');
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
