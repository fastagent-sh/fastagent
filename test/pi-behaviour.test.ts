/**
 * What pi's session layer ACTUALLY does — asserted against pi, not against our code.
 *
 * Every case here was a defect first. The session store and the control plane are built on
 * assumptions about `SessionManager`, and each of these was assumed wrong: a listing that swallows
 * IO errors, a `firstMessage` that is a sentence rather than an empty string, a fork that writes no
 * file, a name that is rewritten on the way in. Code review is a poor instrument for that class —
 * the assumption reads as obviously true right up until someone measures it.
 *
 * So they are measured here, in one place, phrased as questions about pi. Two payoffs: the reasoning
 * behind a defensive-looking line in the store has an executable citation, and a pi upgrade that
 * changes one of these answers turns THIS file red instead of a channel three layers away.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

/** A directory pi will treat as a session directory, plus a record with one exchange in it. */
async function withRecord(): Promise<{ dir: string; record: SessionManager }> {
  const dir = await mkdtemp(join(tmpdir(), "fa-pi-behaviour-"));
  const record = SessionManager.create(dir, dir, { id: "rec" });
  record.appendMessage({ role: "user", content: "first", timestamp: 1 });
  record.appendMessage(fauxAssistantMessage("answered"));
  return { dir, record };
}

describe("pi behaviour the session store is built on", () => {
  it("SessionManager.list SWALLOWS io errors and answers [] — so a store must probe for itself", async () => {
    // Why `list()` stats the directory before asking pi: without it, an unreadable store renders as
    // "this deployment has no conversations" and `sessions_unavailable` can never fire.
    const dir = await mkdtemp(join(tmpdir(), "fa-pi-unreadable-"));
    const sessions = join(dir, "sessions");
    writeFileSync(sessions, "not a directory\n"); // readdir on this is ENOTDIR

    await expect(SessionManager.list(dir, sessions)).resolves.toEqual([]);
  });

  it("firstMessage is a SENTENCE when there is no user text, not an empty string", async () => {
    // Why a list row excludes the literal "(no messages)" by value: truthiness cannot see it, and a
    // client would render pi's placeholder as if a user had typed it.
    const dir = await mkdtemp(join(tmpdir(), "fa-pi-firstmessage-"));
    const record = SessionManager.create(dir, dir, { id: "empty" });
    record.appendMessage(fauxAssistantMessage("only an assistant turn"));

    const [info] = await SessionManager.list(dir, dir);
    expect(info?.firstMessage).toBe("(no messages)");
  });

  it("appendSessionInfo REWRITES the name: newlines collapse, ends trim", async () => {
    // Why a property write reads the name back instead of echoing the request.
    const { dir, record } = await withRecord();
    void dir;
    record.appendSessionInfo("  Deploy\nnotes  ");
    expect(record.getSessionName()).toBe("Deploy notes");
  });

  it("EVERY append advances the single leaf pointer — including metadata", async () => {
    // Why a fork writes its name and provenance BEFORE the history it copies: written after, they
    // would be where a client opening the fork finds its head.
    const { record } = await withRecord();
    const beforeMetadata = record.getLeafId();
    record.appendSessionInfo("a name");
    expect(record.getLeafId()).not.toBe(beforeMetadata);
    record.appendCustomEntry("fastagent.probe", { any: "data" });
    const leaf = record.getEntries().find((e) => e.id === record.getLeafId());
    expect(leaf?.type).toBe("custom"); // a metadata entry, sitting where the conversation's head was
  });

  it("a custom entry is a normal entry in the journal — nothing hides it from a reader", async () => {
    // Why the provenance stamp cannot be assumed absent from `entries()`: the plane publishes every
    // entry that can be a position, and this one can.
    const { record } = await withRecord();
    record.appendCustomEntry("fastagent.probe", { any: "data" });
    expect(record.getEntries().map((e) => e.type)).toContain("custom");
  });

  it("createBranchedSession writes NO file when the copied path has no assistant message", async () => {
    // Why both stores copy a fork entry by entry instead of using pi's file-level fork: the pair
    // (createBranchedSession + forkFrom) fails on the most common fork point there is — "start over
    // from what I asked" — and the failure surfaces as an unreadable source file.
    const dir = await mkdtemp(join(tmpdir(), "fa-pi-branch-"));
    const record = SessionManager.create(dir, dir, { id: "userOnly" });
    const at = record.appendMessage({ role: "user", content: "the question", timestamp: 1 });

    const branched = record.createBranchedSession(at);
    expect(branched).toBeTruthy();
    expect(existsSync(branched as string)).toBe(false); // a path to a file pi has not written
  });

  it("createBranchedSession MUTATES the manager it is called on", async () => {
    // Not currently relied on, and worth knowing before someone does: the parent handle is not a
    // read-only source. Both stores discard the handle after a fork for this reason.
    const { record } = await withRecord();
    const before = record.getSessionId();
    record.createBranchedSession(record.getLeafId() as string);
    expect(record.getSessionId()).not.toBe(before);
  });

  it("a session's `modified` comes from its ENTRIES, so copied history reads as old", async () => {
    // Why a list row floors `updatedAt` at `createdAt`: a fork copies the source's timestamps, and a
    // branch made today would otherwise sort into whenever the original was written — in the one
    // column a conversation list orders by.
    const dir = await mkdtemp(join(tmpdir(), "fa-pi-modified-"));
    mkdirSync(dir, { recursive: true });
    const record = SessionManager.create(dir, dir, { id: "old" });
    record.appendMessage({ role: "user", content: "long ago", timestamp: 1 });
    record.appendMessage({ ...fauxAssistantMessage("also long ago"), timestamp: 2 } as never);

    const [info] = await SessionManager.list(dir, dir);
    expect(info).toBeTruthy();
    // The entry timestamps are from 1970; the file was written seconds ago.
    expect((info as { modified: Date }).modified.getTime()).toBeLessThan(Date.now() - 1000);
  });

  it("a NEW record is buffered in memory until its first assistant message", async () => {
    // Why the store writes the header itself (`publish`) before handing a record out: without it,
    // open-or-create is not idempotent — the second call cannot find the first call's record, and
    // one conversation forks into two files.
    const dir = await mkdtemp(join(tmpdir(), "fa-pi-buffer-"));
    const record = SessionManager.create(dir, dir, { id: "fresh" });
    record.appendMessage({ role: "user", content: "asked", timestamp: 1 });
    expect(existsSync(record.getSessionFile() as string)).toBe(false); // the question is not on disk

    record.appendMessage(fauxAssistantMessage("answered"));
    expect(existsSync(record.getSessionFile() as string)).toBe(true);
  });
});
