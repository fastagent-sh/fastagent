import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log } from "../src/log.ts";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { z } from "zod";
import { collect } from "../src/collect.ts";
import type { AgentEvent } from "../src/agent.ts";
import type { SessionEvent } from "../src/session.ts";
import { defineTool } from "../src/engines/pi/tool.ts";
import { fauxControlledAgent } from "./agent.ts";
import { sentTools } from "./faux.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function workspace(defaultTools?: string[]) {
  const cwd = await mkdtemp(join(tmpdir(), "fa-native-tools-"));
  directories.push(cwd);
  if (defaultTools) {
    await mkdir(join(cwd, ".pi"));
    await writeFile(join(cwd, ".pi/settings.json"), JSON.stringify({ defaultTools }));
  }
  return cwd;
}
const weather = () =>
  defineTool({
    name: "weather",
    description: "Weather forecast",
    exposure: "deferred",
    input: z.object({ city: z.string() }),
    output: z.object({ temperature: z.number() }),
    execute: (_input, ctx) => {
      expect(ctx.sessionManager?.getSessionId()).toBe("room:/native");
      return { temperature: 42 };
    },
  });

describe("Pi-native tool loadouts", () => {
  it("does not load Pi's MCP extension: a workspace mcp.json starts no server", async () => {
    const cwd = await workspace();
    await mkdir(join(cwd, ".pi"));
    const started = join(cwd, "started");
    await writeFile(
      join(cwd, ".pi/mcp.json"),
      JSON.stringify({
        mcpServers: {
          demo: {
            command: process.execPath,
            args: ["-e", `require("fs").writeFileSync(${JSON.stringify(started)}, "")`],
          },
        },
      }),
    );
    const { agent } = await fauxControlledAgent([fauxAssistantMessage("done")], { cwd });
    await collect(agent.invoke({ session: "no-mcp" }, { text: "go" }));
    // The server would be spawned at session_start, before the model is asked.
    expect(existsSync(started)).toBe(false);
  });

  it("honors Pi's own -builtin:<name> setting for the built-ins it loads", async () => {
    const cwd = await workspace();
    await mkdir(join(cwd, ".pi"));
    await writeFile(join(cwd, ".pi/settings.json"), JSON.stringify({ extensions: ["-builtin:codemode"] }));
    let offered: string[] = [];
    const { agent } = await fauxControlledAgent(
      [
        (context) => {
          offered = sentTools(context);
          return fauxAssistantMessage("done");
        },
      ],
      { cwd, tools: [{ ...weather(), exposure: "codemode" }] },
    );
    await collect(agent.invoke({ session: "no-codemode" }, { text: "go" }));
    expect(offered).not.toContain("codemode");
  });

  it("says an extension's repeated notification once, then at debug", async () => {
    const cwd = await workspace();
    const notifier = join(cwd, "notify.mjs");
    await writeFile(
      notifier,
      `export default (pi) => pi.on("session_start", (_event, ctx) => ctx.ui.notify("notifier ${cwd} is misconfigured", "warning"));\n`,
    );
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const debug = vi.spyOn(log, "debug").mockImplementation(() => {});
    try {
      const { agent } = await fauxControlledAgent([fauxAssistantMessage("done"), fauxAssistantMessage("again")], {
        cwd,
        extensionPaths: [notifier],
      });
      await collect(agent.invoke({ session: "headless" }, { text: "go" }));
      await collect(agent.invoke({ session: "headless" }, { text: "go again" }));
      // Every turn starts the extension again; the same notification is a warning once, then debug.
      const said = (spy: typeof warn) =>
        spy.mock.calls.flat().filter((line) => String(line).includes(`notifier ${cwd} is misconfigured`));
      expect(said(warn)).toHaveLength(1);
      expect(said(debug)).toHaveLength(1);
    } finally {
      warn.mockRestore();
      debug.mockRestore();
    }
  });

  it("activates only the discovery tool an authored exposure needs, with no settings", async () => {
    const offeredWith = async (tools: ReturnType<typeof weather>[]) => {
      let offered: string[] = [];
      const { agent } = await fauxControlledAgent(
        [
          (context) => {
            offered = sentTools(context);
            return fauxAssistantMessage("done");
          },
        ],
        { cwd: await workspace(), tools },
      );
      await collect(agent.invoke({ session: "room:/native" }, { text: "go" }));
      return offered;
    };
    const direct = await offeredWith([{ ...weather(), exposure: "direct" }]);
    expect(direct).not.toContain("codemode");
    expect(direct).not.toContain("tool_search");
    const deferred = await offeredWith([weather()]);
    expect(deferred).toContain("tool_search");
    expect(deferred).not.toContain("codemode");
    expect(deferred).not.toContain("weather");
    const scripted = await offeredWith([{ ...weather(), exposure: "codemode" }]);
    expect(scripted).toContain("codemode");
    expect(scripted).not.toContain("tool_search");
  });

  it("inherits +codemode, returns structured output, and retains nested events only on the observation plane", async () => {
    const events: SessionEvent[] = [];
    const { agent, sessions } = await fauxControlledAgent(
      [
        fauxAssistantMessage(
          fauxToolCall(
            "codemode",
            {
              code: "const result = await tools.weather({city: 'London'}); return result.temperature;",
            },
            { id: "outer" },
          ),
        ),
        fauxAssistantMessage("done"),
      ],
      { cwd: await workspace(["+codemode"]), tools: [weather()], observer: (_session, event) => events.push(event) },
    );
    const projected = [];
    for await (const event of agent.invoke({ session: "room:/native" }, { text: "go" })) projected.push(event);
    expect(projected.at(-1)).toMatchObject({ type: "completed" });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool_started",
        data: expect.objectContaining({ id: "outer/1", name: "weather", parentToolCallId: "outer" }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool_finished",
        data: expect.objectContaining({
          id: "outer",
          isError: false,
          content: expect.objectContaining({
            content: expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("42") })]),
          }),
        }),
      }),
    );
    expect(projected.filter((event) => event.type === "tool_started")).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain('"structuredContent"');
    expect(JSON.stringify(projected)).not.toContain('"structuredContent"');
    expect(JSON.stringify((await sessions.openOrCreate("room:/native")).getBranch())).toContain("nestedCalls");
  });

  it("keeps validation and permission hooks on nested codemode calls", async () => {
    const cwd = await workspace(["+codemode"]);
    const policy = join(cwd, "policy.mjs");
    await writeFile(
      policy,
      `export default pi => pi.on("tool_call", event => event.toolName === "weather" && event.input.city === "blocked" ? { block: true, reason: "denied by policy" } : undefined);`,
    );
    const execute = vi.fn(weather().execute);
    const tool = { ...weather(), execute };
    const { agent } = await fauxControlledAgent(
      [
        fauxAssistantMessage(fauxToolCall("codemode", { code: "await tools.weather({})" })),
        fauxAssistantMessage(fauxToolCall("codemode", { code: "await tools.weather({city: 'blocked'})" })),
        fauxAssistantMessage("done"),
      ],
      { cwd, tools: [tool], extensionPaths: [policy] },
    );
    const events = [];
    for await (const event of agent.invoke({ session: "room:/native" }, { text: "go" })) events.push(event);
    expect(events.filter((event) => event.type === "tool_ended").map((event) => event.isError)).toEqual([true, true]);
    expect(JSON.stringify(events)).toContain("denied by policy");
    expect(execute).not.toHaveBeenCalled();
  });

  it("an authored tool orchestrates others: executeTool keeps pi's hooks, onUpdate and nested calls report progress, annotations and namespace reach pi", async () => {
    const cwd = await workspace(["+codemode"]);
    // A permission extension the way pi documents one: it decides from the annotations `getAllTools()` reports.
    const policy = join(cwd, "policy.mjs");
    await writeFile(
      policy,
      `export default pi => pi.on("tool_call", event => pi.getAllTools().find(t => t.name === event.toolName)?.annotations?.readOnlyHint === false ? { block: true, reason: "writes need approval" } : undefined);`,
    );
    const desk = { name: "forecast_desk", description: "Tools of the forecast desk" };
    const lookup = defineTool({
      name: "lookup",
      description: "Look up a temperature",
      exposure: "codemode",
      namespace: desk,
      annotations: { readOnlyHint: true },
      input: z.object({ city: z.string() }),
      output: z.object({ temperature: z.number() }),
      execute: () => ({ temperature: 42 }),
    });
    const save = vi.fn(() => "saved");
    const archive = defineTool({
      name: "archive",
      description: "Archive a forecast",
      exposure: "codemode",
      namespace: desk,
      annotations: { readOnlyHint: false, destructiveHint: true },
      input: z.object({}),
      execute: save,
    });
    const forecast = defineTool({
      name: "forecast",
      description: "Forecast and archive",
      input: z.object({}),
      async execute(_input, ctx) {
        ctx.onUpdate?.("checking London");
        const looked = await ctx.executeTool?.("lookup", { city: "London" });
        const archived = await ctx.executeTool?.("archive", {});
        return { looked: looked?.result.structuredContent, archiveRefused: archived?.isError };
      },
    });
    let codemodeDescription: string | undefined;
    const events: SessionEvent[] = [];
    const { agent } = await fauxControlledAgent(
      [
        (context) => {
          codemodeDescription = getCurrentTools(context.messages).find((t) => t.name === "codemode")?.description;
          return fauxAssistantMessage(fauxToolCall("forecast", {}, { id: "f1" }));
        },
        fauxAssistantMessage("done"),
      ],
      {
        cwd,
        tools: [lookup, archive, forecast],
        extensionPaths: [policy],
        observer: (_s, event) => events.push(event),
      },
    );
    const projected: AgentEvent[] = [];
    for await (const event of agent.invoke({ session: "desk" }, { text: "go" })) projected.push(event);
    expect(projected.at(-1)).toEqual({ type: "completed" });
    // The invoke stream carries the call's status line: its own report, and each call it makes. pi delivers an update
    // and a nested call made in the same tick out of order (the update takes the longer listener path), so only what
    // follows an await is ordered: `archive` starts after `lookup` returned.
    const statuses = projected.flatMap((event) =>
      event.type === "tool_progress" ? [`${event.id} ${event.text}`] : [],
    );
    expect([...statuses].sort()).toEqual(["f1 archive", "f1 checking London", "f1 lookup London"]);
    expect(statuses.at(-1)).toBe("f1 archive");
    expect(codemodeDescription).toContain("forecast_desk");
    expect(codemodeDescription).toContain("Tools of the forecast desk");
    const finished = events.find((e) => e.type === "tool_finished" && (e.data as { id: string }).id === "f1");
    expect(JSON.stringify(finished?.data)).toContain('\\"temperature\\":42');
    expect(JSON.stringify(finished?.data)).toContain('\\"archiveRefused\\":true');
    expect(save).not.toHaveBeenCalled();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool_started",
        data: expect.objectContaining({ name: "lookup", parentToolCallId: "f1" }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool_progress",
        data: expect.objectContaining({
          id: "f1",
          partialResult: expect.objectContaining({ content: [{ type: "text", text: "checking London" }] }),
        }),
      }),
    );
  });

  it("aborts a nested codemode tool when the caller cancels", async () => {
    let start = () => {};
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    let cancelled = false;
    const tool = defineTool({
      name: "wait",
      description: "Wait for cancellation",
      exposure: "codemode",
      input: z.object({}),
      execute: (_args, { signal }) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              cancelled = true;
              reject(new Error("cancelled"));
            },
            { once: true },
          );
          start();
        }),
    });
    const { agent } = await fauxControlledAgent(
      [fauxAssistantMessage(fauxToolCall("codemode", { code: "await tools.wait({})" }))],
      { cwd: await workspace(["+codemode"]), tools: [tool] },
    );
    const iterator = agent.invoke({ session: "cancelled" }, { text: "go" })[Symbol.asyncIterator]();
    const draining = (async () => {
      for (;;) {
        const result = await iterator.next();
        if (result.done) return;
      }
    })();
    await started;
    await iterator.return?.();
    await draining;
    expect(cancelled).toBe(true);
  });

  it("restores native tool_search discoveries across bindings, forks, and compaction", async () => {
    const cwd = await workspace();
    await mkdir(join(cwd, ".pi"));
    await writeFile(join(cwd, ".pi/settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 1 } }));
    const offered: string[][] = [];
    const { agent, control } = await fauxControlledAgent(
      [
        fauxAssistantMessage(fauxToolCall("tool_search", { query: "weather" })),
        fauxAssistantMessage("discovered"),
        ...Array.from({ length: 2 }, () => (context: Parameters<typeof sentTools>[0]) => {
          offered.push(sentTools(context));
          return fauxAssistantMessage("still available");
        }),
        // A one-token window splits the latest turn; Pi summarizes both history and its prefix.
        fauxAssistantMessage("The conversation discovered the weather tool."),
        fauxAssistantMessage("The latest turn asks to keep using weather."),
        (context) => {
          offered.push(sentTools(context));
          return fauxAssistantMessage("available after compaction");
        },
      ],
      { cwd, tools: [weather()] },
    );
    await collect(agent.invoke({ session: "room:/native" }, { text: "discover" }));
    const at = (await control.sessions.get("room:/native").state()).leafEntryId!;
    const fork = await control.sessions.fork({ from: "room:/native", at, into: "fork" });
    expect(fork.ok).toBe(true);
    await collect(agent.invoke({ session: "room:/native" }, { text: "again" }));
    if (fork.ok) await collect(agent.invoke({ session: "fork" }, { text: "fork" }));
    expect(offered).toHaveLength(2);
    for (const tools of offered) expect(tools).toContain("weather");
    const finished = (async () => {
      for await (const event of control.sessions.get("room:/native").events())
        if (event.type === "compaction_finished") return event;
    })();
    expect(await control.sessions.get("room:/native").compact()).toEqual({ ok: true });
    expect((await finished)?.data).toMatchObject({ summary: expect.any(String) });
    await collect(agent.invoke({ session: "room:/native" }, { text: "after compaction" }));
    expect(offered).toHaveLength(3);
    expect(offered.at(-1)).toContain("weather");
  });
});
