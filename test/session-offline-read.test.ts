/**
 * Reading a past turn with NO serve running: the shared journal projection, the fire→turn join `schedule history`
 * prints, and chat's copy-don't-touch rule for a session a serve owns.
 */
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { openSessionCopy } from "../src/engines/pi/chat.ts";
import { canonicalPath } from "../src/engines/pi/definition.ts";
import { readJournal } from "../src/engines/pi/session-journal.ts";
import { piSessionRecordStore } from "../src/engines/pi/session-store.ts";
import { type FireTurn, preview, turnsForFires } from "../src/cli/commands/schedule.ts";
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
/** A SETTLED fire: `ms` is what a claim gets when the turn reported, and it is the fire's own right bound. */
const fire = (iso: string, outcome: Fire["outcome"] = "completed", ms = 60_000): Fire => ({
  slot: iso,
  firedAt: iso,
  outcome,
  ms,
});

/** An UNSETTLED fire: interrupted, still running, or a settlement write that never landed — no duration. */
const unsettled = (iso: string, outcome?: Fire["outcome"]): Fire => ({
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
    // A wake-up, `fastagent fire` by hand and an operator over the control plane write into the same session. An
    // unbounded "nearest user entry" would hand this turn to the 00:00 fire, which produced nothing at all.
    const fires = [fire("2026-01-01T00:00:00.000Z"), fire("2026-01-01T02:00:00.000Z")];
    const turns = turnsForFires(fires, [
      user("manual", "2026-01-01T03:00:00.000Z"),
      assistant("manual-a", "2026-01-01T03:00:01.000Z", { text: "typed by a human" }),
    ]);
    expect(turns.get("2026-01-01T00:00:00.000Z")).toBeUndefined();
    // And the LAST fire is bounded too, by when it ended: it ran for a minute at 02:00, so a turn an hour later is
    // somebody else's. Without this bound the newest claim owns whatever anyone types next, forever.
    expect(turns.get("2026-01-01T02:00:00.000Z")).toBeUndefined();
  });

  it("two claims stamped at the SAME instant fall back to append order", () => {
    // A catch-up slot taken in the same millisecond as a due one: the next fire's bound would then be true for every
    // turn, so the earlier claim would own nothing and the later one would print the earlier one's turn.
    const same = "2026-01-01T00:00:00.000Z";
    const turns = turnsForFires(
      [
        { slot: "s1", firedAt: same, outcome: "completed", ms: 60_000 },
        { slot: "s2", firedAt: same, outcome: "completed", ms: 60_000 },
      ],
      [
        user("u1", "2026-01-01T00:00:00.010Z"),
        assistant("a1", "2026-01-01T00:00:00.020Z", { text: "first reply" }),
        user("u2", "2026-01-01T00:00:00.030Z"),
        assistant("a2", "2026-01-01T00:00:00.040Z", { text: "second reply" }),
      ],
    );
    expect([...turns]).toEqual([
      ["s1", { text: "first reply" }],
      ["s2", { text: "second reply" }],
    ]);
  });

  it("an UNSETTLED fire owns no turn — it cannot say when it ended", () => {
    // `interrupted` is written without a duration, so there is no right bound to test a later turn against. The
    // honest answer is nothing: a fire that never reported has no reply of its own to print anyway.
    const turns = turnsForFires(
      [unsettled("2026-01-01T00:00:00.000Z", "interrupted")],
      [
        user("later", "2026-01-01T09:00:00.000Z"),
        assistant("later-a", "2026-01-01T09:00:01.000Z", { text: "typed by a human, hours later" }),
      ],
    );
    expect(turns.size).toBe(0);
  });

  it("reports nothing for a fire whose turn never got an answer (killed mid-turn)", () => {
    const fires = [unsettled("2026-01-01T00:00:00.000Z", "interrupted")];
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

describe("preview", () => {
  it("marks a cut line with an ellipsis whether it is ASCII or emoji", () => {
    // 150 emoji fill the UTF-16 budget at exactly 100 code points, so judging truncation by what SURVIVED would
    // print a cut line that reads as a reply which was that short.
    expect(preview({ text: "a".repeat(300) })).toBe(`${"a".repeat(100)}\u2026`);
    expect(preview({ text: "\u{1F600}".repeat(150) })).toBe(`${"\u{1F600}".repeat(100)}\u2026`);
    expect(preview({ text: "short" })).toBe("short");
  });

  it("never leaves half a surrogate pair when folding brings the line under the budget", () => {
    // The UTF-16 head cut can split an emoji; whitespace folding then shrinks the line below 100 code points, so it
    // is returned as-is. Keeping the half prints U+FFFD. (`firstUserText` cannot reach this state: it does not fold.)
    const line = preview({ text: `a${" ".repeat(198)}\u{1F600}rest` });
    expect(line).toBe("a \u2026");
    expect(line).not.toMatch(/[\uD800-\uDFFF]/);
  });

  it("never writes a control character to the terminal", () => {
    // A schedule's reply routinely carries a file a tool read; an ANSI escape would repaint this row and the next.
    const line = preview({ text: "x\u001b[31mRED\u001b[0m\u0007" });
    expect(line).not.toMatch(/\p{Cc}/u);
    expect(line).toBe("x [31mRED [0m");
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
    // And in the dir a PLAIN `fastagent chat` uses: pi encodes the cwd into that path, so a workspace reached
    // through a symlink (tmpdir() on macOS is one) would otherwise hide the copy from /resume.
    expect(dirname(copy.getSessionFile() as string)).toBe(
      SessionManager.create(canonicalPath(workspace)).getSessionDir(),
    );
    const copied = readJournal(copy).entries.map((e) => (e.data as { text?: string }).text);
    expect(copied).toEqual(["run 1", "the digest, in full", "why did you say that?", "because of X"]);
  });

  it("repairs the dangling toolCall a killed turn left, so the copy's first message is not rejected", async () => {
    // The session most worth opening this way is the one a fire was KILLED in the middle of (`interrupted`), and
    // `openIfExists` is the one open path that does not reconcile — so the copy would carry an unmatched tool_use
    // and the provider would reject this chat's first request.
    const workspace = await mkdtemp(join(tmpdir(), "fa-chat-dangling-"));
    const sessionsDir = join(workspace, "sessions");
    const store = piSessionRecordStore({ dir: sessionsDir, cwd: workspace });
    const served = await store.openOrCreate("schedule:job");
    served.appendMessage({ role: "user", content: "run 1", timestamp: 1 });
    served.appendMessage(fauxAssistantMessage([fauxToolCall("search", { q: "x" }, { id: "call-1" })]));
    const servedFile = served.getSessionFile() as string;
    const before = readFileSync(servedFile, "utf8");

    const copy = await openSessionCopy(workspace, sessionsDir, "schedule:job");

    const repaired = readJournal(copy).entries.filter((e) => e.kind === "tool");
    expect(repaired.map((e) => (e.data as { toolCallId?: string }).toolCallId)).toEqual(["call-1"]);
    expect((repaired[0] as SessionEntry).data as { isError?: boolean }).toMatchObject({ isError: true });
    // The repair is an APPEND, and the served record is not chat's to write.
    expect(readFileSync(servedFile, "utf8")).toBe(before);
  });

  it("refuses an id that has no record, naming the directory it looked in", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "fa-chat-missing-"));
    const sessionsDir = join(workspace, "sessions");
    await expect(openSessionCopy(workspace, sessionsDir, "schedule:nope")).rejects.toThrow(/schedule:nope/);
  });
});
