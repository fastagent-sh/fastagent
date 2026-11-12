import type { ToolRegistration } from "@earendil-works/pi-durable";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Needs } from "../src/harnesses/pi-durable/define.ts";

let tool: ToolRegistration;

beforeAll(async () => {
  const path = new URL("../src/channels/slack/scaffold/slack-send.ts", import.meta.url).pathname;
  const declared = ((await import(path)) as { default: Needs<ToolRegistration> }).default;
  tool = declared.build({ SLACK_BOT_TOKEN: "xoxb-test" }, {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Run the tool as the agent does, and read what it said. */
async function execute(params: unknown): Promise<{ details: unknown }> {
  const result = await tool.execute(params as never, {} as never, {} as never);
  return { details: (result.output?.[0] as { text: string } | undefined)?.text };
}

describe("scaffold slack-send", () => {
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
});
