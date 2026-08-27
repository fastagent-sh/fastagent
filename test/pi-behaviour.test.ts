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
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
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
  it("SessionManager.list swallows io errors, drops what it cannot parse, and FILTERS BY CWD", async () => {
    // Three reasons the store does its own readdir instead of asking pi for a listing. The third is
    // the one that cost the most: the cwd filter is right for a TUI ("this project's sessions") and
    // catastrophic for a repository, where renaming the agent directory emptied both the listing and
    // the lookup built on it — the next turn then started an empty session on top of the old one.
    const dir = await mkdtemp(join(tmpdir(), "fa-pi-listing-"));
    const own = join(dir, "own");
    mkdirSync(own, { recursive: true });

    // 1. an io fault answers [] rather than throwing
    const notADir = join(dir, "not-a-dir");
    writeFileSync(notADir, "a file\n");
    await expect(SessionManager.list(dir, notADir)).resolves.toEqual([]);

    const ours = SessionManager.create(dir, own, { id: "ours" });
    ours.appendMessage({ role: "user", content: "q", timestamp: 1 });
    ours.appendMessage(fauxAssistantMessage("a"));
    // 2. a record it cannot parse is dropped, silently
    writeFileSync(join(own, "2020-01-01T00-00-00-000Z_corrupt.jsonl"), "not a header\n");
    // 3. a record written under another cwd is filtered out
    const elsewhere = SessionManager.create(join(dir, "elsewhere"), own, { id: "elsewhere" });
    elsewhere.appendMessage({ role: "user", content: "q", timestamp: 1 });
    elsewhere.appendMessage(fauxAssistantMessage("a"));

    expect(readdirSync(own)).toHaveLength(3);
    expect((await SessionManager.list(dir, own)).map((r) => r.id)).toEqual(["ours"]);
  });

  it("open() on a record it cannot read THROWS — which is what makes a per-record fault visible", async () => {
    // The other half of the reason the store opens records itself: unlike `list`, `open` says so.
    const dir = await mkdtemp(join(tmpdir(), "fa-pi-open-"));
    const corrupt = join(dir, "2020-01-01T00-00-00-000Z_corrupt.jsonl");
    writeFileSync(corrupt, "not a header\n");
    expect(() => SessionManager.open(corrupt, dir)).toThrow(/not a valid pi session/);
  });

  it("getBranch(id) answers [] for an id that is not there — it does not throw", async () => {
    // Why a leaf move is validated (getEntry + navigable) BEFORE anything resolves settings against
    // the branch it names: an unknown id would otherwise resolve to an empty path, which reads as a
    // session with no overrides at all rather than as a mistake.
    const { record } = await withRecord();
    expect(record.getBranch("nope")).toEqual([]);
    expect(() => record.branch("nope")).toThrow(/not found/);
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

  it("branch() writes NOTHING, and open() puts the leaf back on the file's last entry", async () => {
    // The one this file was missing, and the defect it cost: a leaf move is RUNTIME state. The store
    // anchors a move with an append for exactly this reason — without it `update({ leafEntryId })`
    // emitted an event that `state()` contradicted a moment later, and the next turn hung off the
    // old tip. Every test that covered the move used the in-memory store, which shares one handle.
    const { dir, record } = await withRecord();
    const first = record.getEntries()[0]?.id as string;
    const tip = record.getLeafId();
    expect(first).not.toBe(tip);

    const before = record.getEntries().length;
    record.branch(first);
    expect(record.getLeafId()).toBe(first);
    expect(record.getEntries()).toHaveLength(before); // the move is not a record

    const reopened = SessionManager.open(record.getSessionFile() as string, dir);
    expect(reopened.getLeafId()).toBe(tip); // …so reopening forgets it

    // An append is what pins it: the new entry becomes the file's last, and its parent is the target.
    record.branch(first);
    record.appendCustomEntry("fastagent.probe", {});
    const pinned = SessionManager.open(record.getSessionFile() as string, dir);
    expect(pinned.getBranch().map((e) => e.id)).toContain(first);
    expect(pinned.getBranch().map((e) => e.id)).not.toContain(tip);
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
