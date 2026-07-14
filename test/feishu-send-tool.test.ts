import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// The scaffolded send tool is real shipped code — its mode switch is the delivery path for
// scheduled/woken turns, so the branches get real executions here. The template stays DATA to tsc
// (excluded from the program — it imports the published "@fastagent-sh/fastagent", unresolvable in-repo), so
// it is loaded via a non-literal dynamic import; vitest's alias resolves that name to today's source.

type RawExecute = (id: string, params: unknown) => Promise<{ details: unknown }>;
let execute: (params: unknown) => Promise<{ details: unknown }>;
beforeAll(async () => {
  const templatePath = new URL("../src/channels/feishu/scaffold/feishu-send.ts", import.meta.url).pathname;
  const mod = (await import(templatePath)) as { default: unknown };
  execute = (params) => (mod.default as { execute: RawExecute }).execute("call-1", params);
});

function stubOpenApi(): { calls: { url: string; body: Record<string, unknown> }[] } {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url: String(url), body });
    if (String(url).includes("tenant_access_token")) {
      return Response.json({ code: 0, msg: "ok", tenant_access_token: "T", expire: 7200 });
    }
    return Response.json({ code: 0, msg: "ok", data: { message_id: "om_1" } });
  });
  return { calls };
}

const creds = () => {
  vi.stubEnv("FEISHU_APP_ID", "cli_x");
  vi.stubEnv("FEISHU_APP_SECRET", "sec");
};

describe("canonical scaffold feishu-send: text-or-markdown mode switch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("text → a text message via the tenant token", async () => {
    creds();
    const { calls } = stubOpenApi();
    const r = await execute({ chatId: "oc_42", text: "digest ready" });
    expect(calls[0]?.url).toContain("/auth/v3/tenant_access_token/internal");
    const send = calls[1];
    expect(send?.url).toContain("/im/v1/messages?receive_id_type=chat_id");
    expect(send?.body.receive_id).toBe("oc_42");
    expect(send?.body.msg_type).toBe("text");
    expect(JSON.parse(String(send?.body.content))).toEqual({ text: "digest ready" });
    expect(JSON.stringify(r.details)).toContain("sent message to chat oc_42");
  });

  it("markdown → an inline card with one markdown element", async () => {
    creds();
    const { calls } = stubOpenApi();
    const r = await execute({ chatId: "oc_7", markdown: "# Report\n**done**" });
    const send = calls[1];
    expect(send?.body.msg_type).toBe("interactive");
    const card = JSON.parse(String(send?.body.content));
    expect(card.body.elements[0]).toEqual({ tag: "markdown", content: "# Report\n**done**" });
    expect(JSON.stringify(r.details)).toContain("sent card to chat oc_7");
  });

  it("text AND markdown — or neither — is rejected before any network call", async () => {
    creds();
    const { calls } = stubOpenApi();
    await expect(execute({ chatId: "oc_1", text: "x", markdown: "y" })).rejects.toThrow(/exactly one/);
    await expect(execute({ chatId: "oc_1" })).rejects.toThrow(/exactly one/);
    expect(calls).toHaveLength(0);
  });

  it("missing credentials fail with the env-var names, before any network call", async () => {
    const { calls } = stubOpenApi();
    await expect(execute({ chatId: "oc_1", text: "x" })).rejects.toThrow(/FEISHU_APP_ID/);
    expect(calls).toHaveLength(0);
  });

  it("an Open API error surfaces as a named tool error (fail-fast, no silent ok)", async () => {
    creds();
    vi.stubGlobal("fetch", async (url: string | URL) => {
      if (String(url).includes("tenant_access_token")) {
        return Response.json({ code: 0, msg: "ok", tenant_access_token: "T", expire: 7200 });
      }
      return Response.json({ code: 230013, msg: "bot has no availability to this user" });
    });
    await expect(execute({ chatId: "oc_1", text: "hello" })).rejects.toThrow(/no availability/);
  });

  it("the Feishu template is locked to the reference cloud", async () => {
    creds();
    const { calls } = stubOpenApi();
    await execute({ chatId: "oc_1", text: "x" });
    expect(calls.every((c) => c.url.startsWith("https://open.feishu.cn/"))).toBe(true);
  });
});

// Lark keeps a branded send-tool edge, but it is the compatibility twin of the canonical Feishu tool.
describe("scaffold lark-send: compatibility cloud binding", () => {
  let larkExecute: (params: unknown) => Promise<{ details: unknown }>;
  beforeAll(async () => {
    const templatePath = new URL("../src/channels/lark/scaffold/lark-send.ts", import.meta.url).pathname;
    const mod = (await import(templatePath)) as { default: unknown };
    larkExecute = (params) => (mod.default as { execute: RawExecute }).execute("call-1", params);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("reads LARK_* credentials and talks to open.larksuite.com", async () => {
    vi.stubEnv("LARK_APP_ID", "cli_x");
    vi.stubEnv("LARK_APP_SECRET", "sec");
    const { calls } = stubOpenApi();
    const r = await larkExecute({ chatId: "oc_9", text: "hi" });
    expect(calls.every((c) => c.url.startsWith("https://open.larksuite.com/"))).toBe(true);
    expect(JSON.stringify(r.details)).toContain("sent message to chat oc_9");
  });

  it("missing credentials fail with the LARK env-var names, before any network call", async () => {
    const { calls } = stubOpenApi();
    await expect(larkExecute({ chatId: "oc_1", text: "x" })).rejects.toThrow(/LARK_APP_ID/);
    expect(calls).toHaveLength(0);
  });
});
