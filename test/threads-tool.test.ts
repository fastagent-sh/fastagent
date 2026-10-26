/**
 * The `{feishu,lark,slack}-threads` scaffold tools: thin over `kit/room-threads.ts`, whose rules are tested there. What
 * each file owes is its wiring: no `threadId` lists, one reads, and the room is the turn's, never an argument.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { createRoomThreads, registerRoomThreads } from "../src/channels/kit/room-threads.ts";
import { resolveStateRoot } from "../src/paths.ts";

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const scaffold = (kind: string) =>
  new URL(`../src/channels/${kind}/scaffold/${kind}-threads.ts`, import.meta.url).pathname;

describe.each(["feishu", "lark", "slack"])("scaffold %s-threads", (kind) => {
  it("lists without a thread id and reads with one, in the room its turn was asked in", async () => {
    // Scaffold files import the published package; Vitest aliases it to the current source.
    const tool = ((await import(scaffold(kind))) as { default: ToolRegistration }).default;
    vi.stubEnv("FASTAGENT_STATE_DIR", "");
    const cwd = await mkdtemp(join(tmpdir(), `fa-${kind}-threads-`));
    dirs.push(cwd);
    const reader = {
      list: vi.fn(async (room: string) => `threads of ${room}`),
      read: vi.fn(async (room: string, threadId: string) => `thread ${threadId} of ${room}`),
    };
    const rooms = createRoomThreads(reader);
    registerRoomThreads(kind, resolveStateRoot(cwd), rooms);
    // The tool runs in conversation 1 of storage "inc": session "inc.1".
    const leave = rooms.enter("inc.1", "room-1");
    const api = {
      conversationId: 1,
      snapshot: async () => ({ incarnation: "inc" }),
      commit: async (change: (tx: unknown) => unknown) => change({ conversation: async (id: number) => ({ id }) }),
    };
    const run = async (params: unknown) => {
      const result = await tool.execute(params as never, api as never, {} as never);
      return (result.output?.[0] as { text: string }).text;
    };

    expect(await run({})).toBe("threads of room-1");
    expect(await run({ threadId: "t-9" })).toBe("thread t-9 of room-1");
    expect(tool.description).toMatch(/Only this (chat|channel)'s threads can be read/);
    leave();
    await expect(run({})).rejects.toThrow(`this turn was not asked in a ${kind} group chat`);
  });
});

it("the lark tool is the feishu one bound to lark", async () => {
  const swapped = (await readFile(scaffold("feishu"), "utf8"))
    .replaceAll("feishuThreads", "larkThreads")
    .replaceAll('"feishu_threads"', '"lark_threads"')
    .replaceAll("@fastagent-sh/fastagent/feishu", "@fastagent-sh/fastagent/lark")
    .replaceAll("Feishu group chat", "Lark group chat");
  expect(await readFile(scaffold("lark"), "utf8")).toBe(swapped);
});
