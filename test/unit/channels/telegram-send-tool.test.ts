import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { Needs } from "../../../src/harnesses/pi-durable/define.ts";

// The scaffolded send tool is real shipped code — its mode switch is the delivery path for
// scheduled/woken turns, so the branches get real executions here. The template stays DATA to tsc
// (excluded from the program — it imports the published "@fastagent-sh/fastagent", unresolvable in-repo), so
// it is loaded via a non-literal dynamic import; vitest's alias resolves that name to today's source.

/** What the tool said, read back as the details these assertions were written against. */
let execute: (params: unknown) => Promise<{ details: unknown }>;
beforeAll(async () => {
  const templatePath = new URL("../../../src/channels/telegram/scaffold/telegram-send.ts", import.meta.url).pathname;
  const mod = (await import(templatePath)) as { default: Needs<ToolRegistration> };
  const tool = mod.default.build({ TELEGRAM_BOT_TOKEN: "tok" }, {});
  execute = async (params) => {
    const result = await tool.execute(params as never, {} as never, {} as never);
    return { details: (result.output?.[0] as { text: string } | undefined)?.text };
  };
});

/** A Bot API that answers like the real one: every sent Message names its id and chat. */
function stubBotApi(): { calls: { url: string; body: FormData | Record<string, unknown> }[] } {
  const calls: { url: string; body: FormData | Record<string, unknown> }[] = [];
  let id = 100;
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    const body =
      init?.body instanceof FormData ? init.body : (JSON.parse(String(init?.body)) as Record<string, unknown>);
    calls.push({ url: String(url), body });
    const chat = body instanceof FormData ? body.get("chat_id") : body.chat_id;
    return Response.json({ ok: true, result: { message_id: ++id, chat: { id: Number(chat) } } });
  });
  return { calls };
}

const json = (call: { body: FormData | Record<string, unknown> } | undefined) => call?.body as Record<string, unknown>;

describe("scaffold telegram-send: message-or-file mode switch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("text → sendMessage with the text in the form", async () => {
    const { calls } = stubBotApi();
    const r = await execute({ chatId: 42, text: "digest ready" });
    expect(calls[0]?.url).toContain("/bottok/sendMessage");
    expect(json(calls[0])).toMatchObject({ chat_id: 42, text: "digest ready" });
    expect(JSON.stringify(r.details)).toContain("sent message to chat 42");
    // No channel is mounted in this test's process: the message went out, and the result says the chat's next turn
    // will not see it.
    expect(JSON.stringify(r.details)).toContain("not recorded: no telegram channel is mounted in this process");
  });
});
