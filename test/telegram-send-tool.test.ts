import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The scaffolded send tool is real shipped code — its mode switch is the delivery path for
// scheduled/woken turns, so the branches get real executions here. The template stays DATA to tsc
// (excluded from the program — it imports the published "@fastagent-sh/fastagent", unresolvable in-repo), so
// it is loaded via a non-literal dynamic import; vitest's alias resolves that name to today's source.

type RawExecute = (id: string, params: unknown) => Promise<{ details: unknown }>;
let execute: (params: unknown) => Promise<{ details: unknown }>;
let description: string;
beforeAll(async () => {
  const templatePath = new URL("../src/channels/telegram/scaffold/telegram-send.ts", import.meta.url).pathname;
  const mod = (await import(templatePath)) as { default: unknown };
  const tool = mod.default as { execute: RawExecute; description: string };
  execute = (params) => tool.execute("call-1", params);
  description = tool.description;
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
const form = (call: { body: FormData | Record<string, unknown> } | undefined) => call?.body as FormData;

describe("scaffold telegram-send: message-or-file mode switch", () => {
  it("steers the model away from using it to answer a normal chat turn (the channel already delivers)", () => {
    expect(description).toMatch(/do not call this to answer/i);
    expect(description).toMatch(/send it twice/i);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("text → sendMessage with the text in the form", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "tok");
    const { calls } = stubBotApi();
    const r = await execute({ chatId: 42, text: "digest ready" });
    expect(calls[0]?.url).toContain("/bottok/sendMessage");
    expect(json(calls[0])).toMatchObject({ chat_id: 42, text: "digest ready" });
    expect(JSON.stringify(r.details)).toContain("sent message to chat 42");
    // No channel is mounted in this test's process: the message went out, and the result says the chat's next turn
    // will not see it.
    expect(JSON.stringify(r.details)).toContain("not recorded: no telegram channel is mounted in this process");
  });

  it("path → sendDocument with the file attached (caption rides along)", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "tok");
    const { calls } = stubBotApi();
    const dir = await mkdtemp(join(tmpdir(), "fa-send-"));
    await writeFile(join(dir, "report.txt"), "hi");
    const r = await execute({ chatId: "7", path: join(dir, "report.txt"), caption: "the report" });
    expect(calls[0]?.url).toContain("/sendDocument");
    expect(form(calls[0]).get("caption")).toBe("the report");
    expect(form(calls[0]).get("document")).toBeInstanceOf(Blob);
    expect(JSON.stringify(r.details)).toContain("sent report.txt to chat 7");
  });

  it("text AND path — or neither — is rejected before any network call", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "tok");
    const { calls } = stubBotApi();
    await expect(execute({ chatId: 1, text: "x", path: "/tmp/y" })).rejects.toThrow(/exactly one/);
    await expect(execute({ chatId: 1 })).rejects.toThrow(/exactly one/);
    expect(calls).toHaveLength(0);
  });

  it("file-only params alongside text are a corrective error, not a silent drop", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "tok");
    const { calls } = stubBotApi();
    await expect(execute({ chatId: 1, text: "x", caption: "lost?" })).rejects.toThrow(/file-mode only/);
    await expect(execute({ chatId: 1, text: "x", asPhoto: true })).rejects.toThrow(/file-mode only/);
    expect(calls).toHaveLength(0);
  });

  it("long text is split by the TOOL (newlines first, then a hard cut) — counting chars is not the model's job", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "tok");
    const { calls } = stubBotApi();
    const line = `${"a".repeat(999)}\n`; // 1000 chars per line → 5000 chars total, newline-splittable
    const r = await execute({ chatId: 9, text: line.repeat(5).trimEnd() });
    expect(calls.length).toBe(2); // one send per chunk, sequential
    const texts = calls.map((c) => String(json(c).text));
    for (const t of texts) expect(t.length).toBeLessThanOrEqual(4096);
    expect(texts.join("\n")).toBe(line.repeat(5).trimEnd()); // nothing lost at the seams
    expect(JSON.stringify(r.details)).toContain("sent 2 messages to chat 9");

    // …and a single line with no newline under the cap is hard-cut, never an infinite loop.
    calls.length = 0;
    await execute({ chatId: 9, text: "b".repeat(4097) });
    expect(calls.length).toBe(2);
    expect(String(json(calls[0]).text)).toHaveLength(4096);
    expect(String(json(calls[1]).text)).toBe("b");
  });

  it("a Bot API error surfaces as a named tool error (fail-fast, no silent ok)", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "tok");
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ ok: false, description: "message is too long" }), { status: 400 }),
    );
    await expect(execute({ chatId: 1, text: "hello" })).rejects.toThrow(/message is too long/);
  });
});
