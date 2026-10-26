import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AgentRejection, failure } from "../src/agent-api.ts";
import { conversationSessions } from "../src/conversation-sessions.ts";
import * as stateFile from "../src/state-file.ts";
import { scriptedAgent } from "./scripted-agent.ts";

vi.mock("../src/state-file.ts", { spy: true });

afterEach(() => {
  vi.restoreAllMocks();
});

const agent = () => scriptedAgent(() => []);

async function mapFile(recorded: Record<string, string> = {}): Promise<string> {
  const file = join(await mkdtemp(join(tmpdir(), "fa-conversations-")), "sessions.json");
  await writeFile(file, JSON.stringify(recorded));
  return file;
}
const recordedIn = async (file: string) => JSON.parse(await readFile(file, "utf8")) as Record<string, string>;

it("reads its file once: a turn of a known conversation reads no file that grows with every conversation", async () => {
  const subject = agent();
  const created = await subject.createSession();
  if (!created.ok) throw new Error("no session");
  const file = await mapFile({ room: created.sessionId });
  const sessions = conversationSessions(file);
  const reads = vi.mocked(stateFile.loadStateFile);
  reads.mockClear();
  for (let i = 0; i < 3; i++) expect(await sessions.of("room", subject)).toBe(created.sessionId);
  await sessions.of("another", subject);
  expect(sessions.get("another")).toBeDefined();
  expect(reads).toHaveBeenCalledTimes(1);
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
  expect(await recordedIn(file)).toEqual({ room: replaced, other: "also-lost" });
  expect(warns.some((line) => line.includes("its session lost is not in the agent's storage"))).toBe(true);
});

it("a storage that cannot answer is the turn's refusal, with its retryable, never a replacement", async () => {
  const unavailable = { ...agent(), read: async () => failure("unavailable", "storage is down") };
  const file = await mapFile({ room: "kept" });
  const refused = conversationSessions(file).of("room", unavailable);
  await expect(refused).rejects.toBeInstanceOf(AgentRejection);
  await expect(refused).rejects.toMatchObject({ code: "unavailable", retryable: true });
  expect(await recordedIn(file)).toEqual({ room: "kept" });
});
