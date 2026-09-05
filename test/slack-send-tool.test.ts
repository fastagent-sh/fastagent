import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { turnContext } from "../src/engines/pi/tool-context.ts";

type RawExecute = (id: string, params: unknown) => Promise<{ details: unknown }>;
let tool: { execute: RawExecute; description: string };

beforeAll(async () => {
  const path = new URL("../src/channels/slack/scaffold/slack-send.ts", import.meta.url).pathname;
  tool = ((await import(path)) as { default: typeof tool }).default;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** Run the tool the way a served turn does: bound to an agent's workspace, credentials in env. */
async function execute(params: unknown): Promise<{ details: unknown }> {
  const cwd = await mkdtemp(join(tmpdir(), "fa-slack-send-"));
  await writeFile(join(cwd, "fastagent.config.ts"), "");
  vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test");
  return turnContext.run({ cwd }, () => tool.execute("call-1", params));
}

describe("scaffold slack-send", () => {
  it("steers the model away from using it to answer a normal chat turn (the channel already delivers)", () => {
    expect(tool.description).toMatch(/do not call this to answer/i);
    expect(tool.description).toMatch(/post the message twice/i);
  });

  it("posts standard Markdown to the selected channel/thread with the bot token and reports the ts", async () => {
    const calls: { url: string; authorization: string | null; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
        body: JSON.parse(String(init?.body)),
      });
      return Response.json({ ok: true, ts: "1.0" });
    });
    const result = await execute({ channelId: "C1", threadTs: "9.0", text: "hello" });
    expect(calls[0]?.url).toBe("https://slack.com/api/chat.postMessage");
    expect(calls[0]?.authorization).toBe("Bearer xoxb-test");
    expect(calls[0]?.body).toMatchObject({ channel: "C1", thread_ts: "9.0", markdown_text: "hello" });
    expect(result.details).toBe("sent message to Slack channel C1 (ts 1.0)");
  });

  it("uploads a local file through the channel transport and names the file id", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/files.getUploadURLExternal")) {
        return Response.json({ ok: true, upload_url: "https://files.slack.com/upload/v1/token", file_id: "F1" });
      }
      if (url.includes("/upload/v1/")) return new Response("OK", { status: 200 });
      return Response.json({ ok: true, files: [{ id: "F1" }] });
    });
    const dir = await mkdtemp(join(tmpdir(), "fa-slack-send-file-"));
    const path = join(dir, "report.txt");
    await writeFile(path, "report");

    const result = await execute({ channelId: "C1", path, title: "Daily report" });
    expect(urls).toEqual([
      "https://slack.com/api/files.getUploadURLExternal",
      "https://files.slack.com/upload/v1/token",
      "https://slack.com/api/files.completeUploadExternal",
    ]);
    expect(result.details).toBe("uploaded report.txt to Slack channel C1 (file F1)");
  });

  it("rejects ambiguous mode before network IO and surfaces Slack API errors", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: false, error: "missing_scope" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(execute({ channelId: "C1", text: "x", path: "/tmp/x" })).rejects.toThrow(/exactly one/);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(execute({ channelId: "C1", text: "x" })).rejects.toThrow(/missing_scope/);
  });
});
