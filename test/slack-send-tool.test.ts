import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

type RawExecute = (id: string, params: unknown) => Promise<{ details: unknown }>;
let execute: (params: unknown) => Promise<{ details: unknown }>;
let description: string;

beforeAll(async () => {
  const path = new URL("../src/channels/slack/scaffold/slack-send.ts", import.meta.url).pathname;
  const mod = (await import(path)) as { default: unknown };
  const tool = mod.default as { execute: RawExecute; description: string };
  execute = (params) => tool.execute("call-1", params);
  description = tool.description;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("scaffold slack-send", () => {
  it("steers the model away from using it to answer a normal chat turn (the channel already delivers)", () => {
    expect(description).toMatch(/do not call this to answer/i);
    expect(description).toMatch(/post the message twice/i);
  });

  it("posts standard Markdown to the selected channel/thread", async () => {
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test");
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return Response.json({ ok: true, ts: "1.0" });
    });
    const result = await execute({ channelId: "C1", threadTs: "9.0", text: "hello" });
    expect(calls[0]?.url).toContain("/chat.postMessage");
    expect(calls[0]?.body).toMatchObject({ channel: "C1", thread_ts: "9.0", markdown_text: "hello" });
    expect(JSON.stringify(result.details)).toContain("sent message");
  });

  it("uses Slack's external-upload three-step protocol and completes in the parent thread", async () => {
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test");
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      let body: unknown = init?.body;
      if (url.startsWith("https://slack.com/api/")) body = JSON.parse(String(init?.body));
      calls.push({ url, body });
      if (url.endsWith("/files.getUploadURLExternal")) {
        return Response.json({ ok: true, upload_url: "https://files.slack.com/upload/v1/token", file_id: "F1" });
      }
      if (url.includes("/upload/v1/")) return new Response("OK", { status: 200 });
      return Response.json({ ok: true, files: [{ id: "F1" }] });
    });
    const dir = await mkdtemp(join(tmpdir(), "fa-slack-send-"));
    const path = join(dir, "report.txt");
    await writeFile(path, "report");

    const result = await execute({
      channelId: "C1",
      threadTs: "9.0",
      path,
      title: "Daily report",
      initialComment: "attached",
    });
    expect(calls.map((call) => call.url)).toEqual([
      "https://slack.com/api/files.getUploadURLExternal",
      "https://files.slack.com/upload/v1/token",
      "https://slack.com/api/files.completeUploadExternal",
    ]);
    expect(calls[0]?.body).toEqual({ filename: "report.txt", length: 6 });
    expect(calls[2]?.body).toMatchObject({
      files: [{ id: "F1", title: "Daily report" }],
      channel_id: "C1",
      thread_ts: "9.0",
      initial_comment: "attached",
    });
    expect(JSON.stringify(result.details)).toContain("uploaded report.txt");
  });

  it("rejects ambiguous mode before network IO and surfaces Slack API errors", async () => {
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test");
    const fetchMock = vi.fn(async () => Response.json({ ok: false, error: "missing_scope" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(execute({ channelId: "C1", text: "x", path: "/tmp/x" })).rejects.toThrow(/exactly one/);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(execute({ channelId: "C1", text: "x" })).rejects.toThrow(/missing_scope/);
  });
});
