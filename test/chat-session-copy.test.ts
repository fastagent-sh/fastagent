/**
 * `chat --session`: opening a session a serve owns, as a copy. The served record is never opened for append, the copy
 * lands where a plain `chat` would find it, and a turn killed mid tool-call is repaired on the way in.
 */
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { openSessionCopy } from "../src/engines/pi/chat.ts";
import { canonicalPath } from "../src/engines/pi/definition.ts";
import { piSessionRecordStore } from "../src/engines/pi/session-store.ts";

/** The messages on a record's active path, in append order. */
function messages(record: SessionManager): AgentMessage[] {
  return (record.getBranch() as { type?: string; message?: AgentMessage }[]).flatMap((e) =>
    e.type === "message" && e.message ? [e.message] : [],
  );
}

/** Concatenated text of a message's content blocks. */
function textOf(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as { type: string; text?: string }[])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

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
    expect(messages(copy).map(textOf)).toEqual([
      "run 1",
      "the digest, in full",
      "why did you say that?",
      "because of X",
    ]);
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

    const repaired = messages(copy).filter((m) => (m as { role?: string }).role === "toolResult");
    expect(repaired.map((m) => (m as { toolCallId?: string }).toolCallId)).toEqual(["call-1"]);
    expect(repaired[0]).toMatchObject({ isError: true });
    // The repair is an APPEND, and the served record is not chat's to write.
    expect(readFileSync(servedFile, "utf8")).toBe(before);
  });

  it("refuses an id that has no record, naming the directory it looked in", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "fa-chat-missing-"));
    const sessionsDir = join(workspace, "sessions");
    await expect(openSessionCopy(workspace, sessionsDir, "schedule:nope")).rejects.toThrow(/schedule:nope/);
  });
});
