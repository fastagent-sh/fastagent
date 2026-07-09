import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sendTool from "../src/channels/telegram/scaffold/telegram-send.ts";

// The scaffolded send tool is real shipped code (a compiled module, not a text template) — its mode
// switch is the delivery path for scheduled/woken turns, so the branches get real executions here.

type RawExecute = (id: string, params: unknown) => Promise<{ details: unknown }>;
const execute = (params: unknown): Promise<{ details: unknown }> =>
  (sendTool as unknown as { execute: RawExecute }).execute("call-1", params);

function stubBotApi(): { calls: { url: string; form: FormData }[] } {
  const calls: { url: string; form: FormData }[] = [];
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), form: init?.body as FormData });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  return { calls };
}

describe("scaffold telegram-send: message-or-file mode switch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("text → sendMessage with the text in the form", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "tok");
    const { calls } = stubBotApi();
    const r = await execute({ chatId: 42, text: "digest ready" });
    expect(calls[0]?.url).toContain("/bottok/sendMessage");
    expect(calls[0]?.form.get("chat_id")).toBe("42");
    expect(calls[0]?.form.get("text")).toBe("digest ready");
    expect(JSON.stringify(r.details)).toContain("sent message to chat 42");
  });

  it("path → sendDocument with the file attached (caption rides along)", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "tok");
    const { calls } = stubBotApi();
    const dir = await mkdtemp(join(tmpdir(), "fa-send-"));
    await writeFile(join(dir, "report.txt"), "hi");
    const r = await execute({ chatId: "7", path: join(dir, "report.txt"), caption: "the report" });
    expect(calls[0]?.url).toContain("/sendDocument");
    expect(calls[0]?.form.get("caption")).toBe("the report");
    expect(calls[0]?.form.get("document")).toBeInstanceOf(Blob);
    expect(JSON.stringify(r.details)).toContain("sent report.txt to chat 7");
  });

  it("text AND path — or neither — is rejected before any network call", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "tok");
    const { calls } = stubBotApi();
    await expect(execute({ chatId: 1, text: "x", path: "/tmp/y" })).rejects.toThrow(/exactly one/);
    await expect(execute({ chatId: 1 })).rejects.toThrow(/exactly one/);
    expect(calls).toHaveLength(0);
  });

  it("a Bot API error surfaces as a named tool error (fail-fast, no silent ok)", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "tok");
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ ok: false, description: "message is too long" }), { status: 400 }),
    );
    await expect(execute({ chatId: 1, text: "x".repeat(5000) })).rejects.toThrow(/message is too long/);
  });
});
