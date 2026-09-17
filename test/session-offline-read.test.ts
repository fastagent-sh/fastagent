/**
 * Reading a past turn with NO serve running: the shared journal projection, the fire→turn join `schedule history`
 * prints, and chat's copy-don't-touch rule for a session a serve owns.
 */
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { openSessionCopy } from "../src/engines/pi/chat.ts";
import { readJournal } from "../src/engines/pi/session-journal.ts";
import { piSessionRecordStore } from "../src/engines/pi/session-store.ts";
import { type FireTurn, turnsForFires } from "../src/cli/commands/schedule.ts";
import type { Fire } from "../src/schedule/state.ts";
import type { SessionEntry } from "../src/session.ts";

const at = (iso: string): number => Date.parse(iso);

/** The shape the join consumes, built directly so the window rules are tested without a record. */
const user = (id: string, iso: string): SessionEntry => ({ id, timestamp: at(iso), kind: "user", data: { text: id } });
const assistant = (id: string, iso: string, data: SessionEntry["data"]): SessionEntry => ({
  id,
  timestamp: at(iso),
  kind: "assistant",
  data,
});
const fire = (iso: string, outcome?: Fire["outcome"]): Fire => ({
  slot: iso,
  firedAt: iso,
  ...(outcome ? { outcome } : {}),
});

describe("turnsForFires", () => {
  it("gives each fire the turn inside its own window, and the LAST assistant of it", () => {
    const fires = [fire("2026-01-01T00:00:00.000Z"), fire("2026-01-01T01:00:00.000Z")];
    const turns = turnsForFires(fires, [
      user("u1", "2026-01-01T00:00:01.000Z"),
      // A tool-calling turn appends several assistant records; the reply is the last one.
      assistant("a1", "2026-01-01T00:00:02.000Z", { text: "", toolCalls: [{ id: "t", name: "search" }] }),
      assistant("a2", "2026-01-01T00:00:03.000Z", { text: "the digest, in full" }),
      user("u2", "2026-01-01T01:00:01.000Z"),
      assistant("a3", "2026-01-01T01:00:02.000Z", { text: "the second one" }),
    ]);
    expect(turns.get("2026-01-01T00:00:00.000Z")?.text).toBe("the digest, in full");
    expect(turns.get("2026-01-01T01:00:00.000Z")?.text).toBe("the second one");
  });

  it("does not attribute another writer's turn to a fire — the window closes at the NEXT fire", () => {
    // `fastagent fire` by hand and an operator steering through attach write into the same session. An unbounded
    // "nearest user entry" would hand this turn to the 00:00 fire, which produced nothing at all.
    const fires = [fire("2026-01-01T00:00:00.000Z"), fire("2026-01-01T02:00:00.000Z")];
    const turns = turnsForFires(fires, [
      user("manual", "2026-01-01T03:00:00.000Z"),
      assistant("manual-a", "2026-01-01T03:00:01.000Z", { text: "typed by a human" }),
    ]);
    expect(turns.get("2026-01-01T00:00:00.000Z")).toBeUndefined();
    // The last fire's window is open-ended, so a later turn IS its turn — the only writer after it is that fire.
    expect(turns.get("2026-01-01T02:00:00.000Z")?.text).toBe("typed by a human");
  });

  it("reports nothing for a fire whose turn never got an answer (killed mid-turn)", () => {
    const fires = [fire("2026-01-01T00:00:00.000Z", "interrupted")];
    const turns = turnsForFires(fires, [user("u1", "2026-01-01T00:00:01.000Z")]);
    expect(turns.size).toBe(0);
  });

  it("carries WHY a turn failed, which no claim holds", () => {
    const turns = turnsForFires(
      [fire("2026-01-01T00:00:00.000Z", "failed")],
      [
        user("u1", "2026-01-01T00:00:01.000Z"),
        assistant("a1", "2026-01-01T00:00:02.000Z", { text: "", errorMessage: "provider exploded" }),
      ],
    );
    expect(turns.get("2026-01-01T00:00:00.000Z")).toEqual({ text: "", error: "provider exploded" } satisfies FireTurn);
  });
});

describe("readJournal", () => {
  it("publishes the failure reason on the assistant entry, so an offline reader can print it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-journal-"));
    const store = piSessionRecordStore({ dir, cwd: dir });
    const record = await store.openOrCreate("schedule:job");
    record.appendMessage({ role: "user", content: "run 1", timestamp: 1 });
    record.appendMessage(fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider exploded" }));

    const { entries } = readJournal(record);
    const reply = entries.at(-1) as SessionEntry;
    expect(reply.kind).toBe("assistant");
    expect((reply.data as { errorMessage?: string }).errorMessage).toBe("provider exploded");
  });
});

describe("chat --session opens a COPY", () => {
  it("leaves the served record byte-identical while the copy carries its history", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "fa-chat-copy-"));
    const sessionsDir = join(workspace, "sessions");
    const store = piSessionRecordStore({ dir: sessionsDir, cwd: workspace });
    const served = await store.openOrCreate("schedule:job");
    served.appendMessage({ role: "user", content: "run 1", timestamp: 1 });
    served.appendMessage(fauxAssistantMessage("the digest, in full"));
    const servedFile = served.getSessionFile() as string;
    const before = readFileSync(servedFile, "utf8");

    const copy = await openSessionCopy(workspace, sessionsDir, "schedule:job");
    copy.appendMessage({ role: "user", content: "why did you say that?", timestamp: 3 });
    copy.appendMessage(fauxAssistantMessage("because of X"));

    // The record a serve owns is not opened for append: only `attach` writes it.
    expect(readFileSync(servedFile, "utf8")).toBe(before);
    expect(copy.getSessionFile()).not.toBe(servedFile);
    const copied = readJournal(copy).entries.map((e) => (e.data as { text?: string }).text);
    expect(copied).toEqual(["run 1", "the digest, in full", "why did you say that?", "because of X"]);
  });

  it("refuses an id that has no record, naming the directory it looked in", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "fa-chat-missing-"));
    const sessionsDir = join(workspace, "sessions");
    await expect(openSessionCopy(workspace, sessionsDir, "schedule:nope")).rejects.toThrow(/schedule:nope/);
  });
});
