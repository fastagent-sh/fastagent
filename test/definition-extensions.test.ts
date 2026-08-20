/**
 * The definition carries its own `extensions/`: discovered as entry-point FILES, handed to pi as
 * `additionalExtensionPaths`, and reaching the model through the SERVING path — while pi's
 * machine-global discovery stays suppressed.
 */
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { collect, createPiAgentFromDefinition } from "../src/index.ts";
import { loadAgentDefinition } from "../src/engines/pi/definition.ts";
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
    expect((await loadAgentDefinition(dir)).extensionPaths).toEqual([]);
  });

  it("finds direct .ts/.js files and subdirectory index files, ignoring non-extension files", async () => {
    const dir = await agentDirWith({
      "extensions/alpha.ts": markerExtension("alpha"),
      "extensions/beta.js": markerExtension("beta"),
      "extensions/gamma/index.ts": markerExtension("gamma"),
      "extensions/README.md": "not an extension",
      "extensions/data.json": "{}",
    });

    expect((await loadAgentDefinition(dir)).extensionPaths).toEqual([
      join(dir, "extensions", "alpha.ts"),
      join(dir, "extensions", "beta.js"),
      join(dir, "extensions", "gamma", "index.ts"),
    ]);
  });

  it("warns about a subdirectory with no index rather than skipping it silently", async () => {
    const dir = await agentDirWith({ "extensions/pkg/main.ts": markerExtension("pkg") });
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});

    expect((await loadAgentDefinition(dir)).extensionPaths).toEqual([]);
    expect(warn.mock.calls.flat().join("\n")).toContain("expected index.ts or index.js");
    warn.mockRestore();
  });

  it("refuses a symlinked entry, which would not survive the trip into a container", async () => {
    const outside = await mkdtemp(join(tmpdir(), "fa-ext-outside-"));
    await writeFile(join(outside, "escape.ts"), markerExtension("escape"));
    const dir = await agentDirWith({ "extensions/local.ts": markerExtension("local") });
    await symlink(join(outside, "escape.ts"), join(dir, "extensions", "escape.ts"));
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});

    expect((await loadAgentDefinition(dir)).extensionPaths).toEqual([join(dir, "extensions", "local.ts")]);
    expect(warn.mock.calls.flat().join("\n")).toContain("is a symlink and will not be loaded");
    warn.mockRestore();
  });

  it("refuses an extensions/ symlinked outside the agent dir", async () => {
    const outside = await mkdtemp(join(tmpdir(), "fa-ext-outside-"));
    await writeFile(join(outside, "evil.ts"), markerExtension("evil"));
    const dir = await agentDirWith({});
    await symlink(outside, join(dir, "extensions"), "dir");

    await expect(loadAgentDefinition(dir)).rejects.toThrow(/resolves outside the agent dir/);
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
