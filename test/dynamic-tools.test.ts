import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log } from "../src/log.ts";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { z } from "zod";
import { collect } from "../src/protocol-collect.ts";
import type { Entry, InvokeEvent } from "../src/protocol.ts";
import { defineTool } from "../src/harnesses/pi/tool.ts";
import { fauxAgent } from "./agent.ts";
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
/** One message's invoke stream, and the entries its work wrote. */
async function invoked(events: AsyncIterable<InvokeEvent>): Promise<{ events: InvokeEvent[]; entries: Entry[] }> {
  const all: InvokeEvent[] = [];
  for await (const event of events) all.push(event);
  const entries = all.flatMap((event) => (event.type === "entry" ? [event.entry] : []));
  return { events: all, entries };
}
const outcomeOf = (events: InvokeEvent[]) => events.flatMap((e) => (e.type === "done" ? [e.message.outcome] : []))[0];
const toolResults = (entries: Entry[]) =>
  entries.flatMap((e) =>
    e.kind === "tool_result" ? [e.data as { toolCallId: string; isError: boolean; text: string }] : [],
  );

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
    const { agent } = fauxAgent([fauxAssistantMessage("done")], { cwd });
    await collect(agent.invoke({ sessionId: "no-mcp", prompt: { text: "go" } }));
    // The server would be spawned at session_start, before the model is asked.
    expect(existsSync(started)).toBe(false);
  });

  it("honors Pi's own -builtin:<name> setting for the built-ins it loads", async () => {
    const cwd = await workspace();
    await mkdir(join(cwd, ".pi"));
    await writeFile(join(cwd, ".pi/settings.json"), JSON.stringify({ extensions: ["-builtin:codemode"] }));
    let offered: string[] = [];
    const { agent } = fauxAgent(
      [
        (context) => {
          offered = sentTools(context);
          return fauxAssistantMessage("done");
        },
      ],
      { cwd, tools: [{ ...weather(), exposure: "codemode" }] },
    );
    await collect(agent.invoke({ sessionId: "no-codemode", prompt: { text: "go" } }));
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
      const { agent } = fauxAgent([fauxAssistantMessage("done"), fauxAssistantMessage("again")], {
        cwd,
        extensionPaths: [notifier],
      });
      await collect(agent.invoke({ sessionId: "headless", prompt: { text: "go" } }));
      await collect(agent.invoke({ sessionId: "headless", prompt: { text: "go again" } }));
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
      const { agent } = fauxAgent(
        [
          (context) => {
            offered = sentTools(context);
            return fauxAssistantMessage("done");
          },
        ],
        { cwd: await workspace(), tools },
      );
      await collect(agent.invoke({ sessionId: "room:/native", prompt: { text: "go" } }));
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

  it("inherits +codemode, returns structured output, and reports a nested call as its caller's status", async () => {
    const { agent, sessions } = fauxAgent(
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
      { cwd: await workspace(["+codemode"]), tools: [weather()] },
    );
    const { events, entries } = await invoked(agent.invoke({ sessionId: "room:/native", prompt: { text: "go" } }));
    expect(outcomeOf(events)).toEqual({ status: "completed" });
    expect(events.filter((event) => event.type === "tool_started")).toEqual([
      expect.objectContaining({ toolCallId: "outer", name: "codemode" }),
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "tool_progress", toolCallId: "outer", text: "weather London" }),
    );
    expect(toolResults(entries)).toEqual([
      expect.objectContaining({ toolCallId: "outer", isError: false, text: expect.stringContaining("42") }),
    ]);
    expect(JSON.stringify(events)).not.toContain('"structuredContent"');
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
    const { agent } = fauxAgent(
      [
        fauxAssistantMessage(fauxToolCall("codemode", { code: "await tools.weather({})" })),
        fauxAssistantMessage(fauxToolCall("codemode", { code: "await tools.weather({city: 'blocked'})" })),
        fauxAssistantMessage("done"),
      ],
      { cwd, tools: [tool], extensionPaths: [policy] },
    );
    const { entries } = await invoked(agent.invoke({ sessionId: "room:/native", prompt: { text: "go" } }));
    const results = toolResults(entries);
    expect(results.map((result) => result.isError)).toEqual([true, true]);
    expect(results[1]?.text).toContain("denied by policy");
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
    const { agent } = fauxAgent(
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
      },
    );
    const { events, entries } = await invoked(agent.invoke({ sessionId: "desk", prompt: { text: "go" } }));
    expect(outcomeOf(events)).toEqual({ status: "completed" });
    // The invoke stream carries the call's status line: its own report, and each call it makes. pi delivers an update
    // and a nested call made in the same tick out of order (the update takes the longer listener path), so only the
    // last is certain: `archive` starts after `lookup` returned.
    const statuses = events.flatMap((event) =>
      event.type === "tool_progress" ? [`${event.toolCallId} ${event.text}`] : [],
    );
    expect(statuses.at(-1)).toBe("f1 archive");
    expect(
      statuses.filter((status) => !["f1 checking London", "f1 lookup London", "f1 archive"].includes(status)),
    ).toEqual([]);
    expect(codemodeDescription).toContain("forecast_desk");
    expect(codemodeDescription).toContain("Tools of the forecast desk");
    const forecastResult = toolResults(entries).find((result) => result.toolCallId === "f1");
    expect(forecastResult?.text).toContain('"temperature":42');
    expect(forecastResult?.text).toContain('"archiveRefused":true');
    expect(save).not.toHaveBeenCalled();
  });

  it("aborts a nested codemode tool when the run is canceled", async () => {
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
    const { agent } = fauxAgent([fauxAssistantMessage(fauxToolCall("codemode", { code: "await tools.wait({})" }))], {
      cwd: await workspace(["+codemode"]),
      tools: [tool],
    });
    const run = invoked(agent.invoke({ sessionId: "cancelled", prompt: { text: "go" } }));
    await started;
    const read = await agent.sessions.get("cancelled").read({ limit: 0 });
    const messageId = read.ok ? read.state.taken[0]?.messageId : undefined;
    if (!messageId) throw new Error("no message taken");
    expect(await agent.sessions.get("cancelled").messages.cancel(messageId)).toEqual({ ok: true });
    expect(outcomeOf((await run).events)).toEqual({ status: "canceled" });
    expect(cancelled).toBe(true);
  });

  it("restores native tool_search discoveries across bindings, forks, and compaction", async () => {
    const cwd = await workspace();
    await mkdir(join(cwd, ".pi"));
    await writeFile(join(cwd, ".pi/settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 1 } }));
    const offered: string[][] = [];
    const { agent } = fauxAgent(
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
    await collect(agent.invoke({ sessionId: "room:/native", prompt: { text: "discover" } }));
    const read = await agent.sessions.get("room:/native").read({ limit: 0 });
    const at = read.ok ? read.state.leafEntryId : undefined;
    const fork = await agent.sessions.create({ sessionId: "fork", fork: { sessionId: "room:/native", entryId: at } });
    expect(fork.ok).toBe(true);
    await collect(agent.invoke({ sessionId: "room:/native", prompt: { text: "again" } }));
    if (fork.ok) await collect(agent.invoke({ sessionId: "fork", prompt: { text: "fork" } }));
    expect(offered).toHaveLength(2);
    for (const tools of offered) expect(tools).toContain("weather");
    expect(await agent.sessions.get("room:/native").compact()).toEqual({ ok: true });
    const after = await agent.sessions.get("room:/native").read();
    const compaction = after.ok ? after.entries.find((entry) => entry.kind === "compaction") : undefined;
    expect(compaction?.data).toMatchObject({ summary: expect.any(String) });
    await collect(agent.invoke({ sessionId: "room:/native", prompt: { text: "after compaction" } }));
    expect(offered).toHaveLength(3);
    expect(offered.at(-1)).toContain("weather");
  });
});
