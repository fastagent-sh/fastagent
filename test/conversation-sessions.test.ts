import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AgentError, agentError } from "../src/agent-api.ts";
import { conversationSessions } from "../src/conversation-sessions.ts";
import { scriptedAgent } from "./scripted-agent.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

const agent = () => scriptedAgent(() => []);

async function mapFile(recorded: Record<string, string> = {}): Promise<string> {
  const file = join(await mkdtemp(join(tmpdir(), "fa-conversations-")), "sessions.json");
  await writeFile(file, JSON.stringify(recorded));
  return file;
}
/** An Agent that holds the session `id` and no other. */
function agentHolding(id: string) {
  const base = agent();
  return {
    ...base,
    sessions: {
      ...base.sessions,
      get: async (sessionId: string) => {
        if (sessionId !== id) throw agentError("not_found", `no session ${sessionId}`);
        return { id } as never;
      },
    },
  };
}

it("reads its file once: a turn of a known conversation reads no file that grows with every conversation", async () => {
  const subject = agent();
  const created = await subject.sessions.create();
  const file = await mapFile({ room: created.id });
  const sessions = conversationSessions(file);
  expect(await sessions.of("room", subject)).toBe(created.id);
  // The file changes under it: what it answers is what it read the first time.
  await writeFile(file, JSON.stringify({ room: "elsewhere" }));
  for (let i = 0; i < 3; i++) expect(await sessions.of("room", subject)).toBe(created.id);
});

it("a recorded session the Agent no longer holds is replaced and recorded, and said so", async () => {
  // The storage was reset (or restored from an older copy) under a map that outlived it: every message would
  // otherwise be refused `not_found`, with nothing pointing at the file to delete.
  const warns: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void warns.push(args.join(" ")));
  const file = await mapFile({ room: "lost", other: "also-lost" });
  const sessions = conversationSessions(file);
  const replaced = await sessions.of("room", agent());
  expect(replaced).not.toBe("lost");
  // Recorded: a restart opens the conversation in the session that replaced the lost one.
  expect(await conversationSessions(file).of("room", agentHolding(replaced))).toBe(replaced);
  expect(warns.some((line) => line.includes("its session lost is not in the agent's storage"))).toBe(true);
});

it("a storage that cannot answer is the turn's refusal, with its retryable, never a replacement", async () => {
  const base = agent();
  const unavailable = {
    ...base,
    sessions: {
      ...base.sessions,
      get: async () => {
        throw agentError("unavailable", "storage is down");
      },
    },
  };
  const file = await mapFile({ room: "kept" });
  const refused = conversationSessions(file).of("room", unavailable);
  await expect(refused).rejects.toBeInstanceOf(AgentError);
  await expect(refused).rejects.toMatchObject({ code: "unavailable", retryable: true });
  // Nothing was replaced: once the storage answers again, the conversation is in the session it was.
  expect(await conversationSessions(file).of("room", agentHolding("kept"))).toBe("kept");
});
