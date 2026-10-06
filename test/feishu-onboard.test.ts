import { describe, expect, it } from "vitest";
import { checkAgentScopes } from "../src/cli/add-feishu.ts";
import type { FeishuAppScope, FeishuApi } from "../src/channels/feishu/feishu-api.ts";
import {
  FEISHU_AGENT_SCOPES,
  FEISHU_APP_CONFIG_SCOPE,
  FEISHU_MESSAGE_RECEIVE_EVENT,
  feishuAppAddons,
} from "../src/channels/feishu/setup-mode.ts";

const AGENT_SCOPES = FEISHU_AGENT_SCOPES.map((entry) => entry.request);
const grantedAll = (): FeishuAppScope[] => AGENT_SCOPES.map((name) => ({ name, grantStatus: 1, type: "tenant" }));

async function check(kind: "feishu" | "lark", listAppScopes: Pick<FeishuApi, "listAppScopes">["listAppScopes"]) {
  const notes: string[] = [];
  const opened: string[] = [];
  const result = await checkAgentScopes({
    kind,
    appId: "cli_a",
    apiBase: kind === "feishu" ? "https://open.feishu.cn" : "https://open.larksuite.com",
    api: { listAppScopes },
    note: (message) => notes.push(message),
    openUrl: (url) => opened.push(url),
  });
  return { result, notes: notes.join("\n"), opened };
}

/** The `q` of a pre-filled scope-request link, as the list of scopes it asks for. */
const requested = (url: string | undefined): string[] => new URL(url ?? "").searchParams.get("q")?.split(",") ?? [];

describe("Feishu/Lark agent permission check", () => {
  it("an app holding every agent scope is ready to publish, and no console page opens", async () => {
    const { result, notes, opened } = await check("feishu", async () => grantedAll());
    expect(result).toEqual({ publishReady: true });
    expect(notes).toContain("granted");
    expect(opened).toEqual([]);
  });

  it("names each missing scope with its state, and opens the console pre-filled with exactly those", async () => {
    // A tenant can withhold a scope the confirm page asked for (its approval policy), or an app made by hand never
    // had it; the author is sent to request precisely what is missing.
    const scopes = grantedAll()
      .filter((scope) => scope.name !== "im:chat.members:read")
      .map((scope) => (scope.name === "im:message.group_msg" ? { ...scope, grantStatus: 0 } : scope));
    const { result, notes, opened } = await check("feishu", async () => scopes);
    expect(result).toEqual({ publishReady: false });
    expect(notes).toContain("im:message.group_msg (awaiting approval)");
    expect(notes).toContain("im:chat.members:read (not on the app)");
    expect(opened).toHaveLength(1);
    expect(new URL(opened[0] as string).pathname).toBe("/app/cli_a/auth");
    expect(requested(opened[0])).toEqual(["im:message.group_msg", "im:chat.members:read"]);
  });

  it("a broader scope satisfies a narrower one, and a user-type entry satisfies nothing", async () => {
    const scopes: FeishuAppScope[] = [
      ...grantedAll().filter((scope) => scope.name !== "im:message:readonly" && scope.name !== "im:chat.members:read"),
      { name: "im:message", grantStatus: 1, type: "tenant" },
      { name: "im:chat.members:read", grantStatus: 1, type: "user" },
    ];
    const { opened } = await check("lark", async () => scopes);
    expect(requested(opened[0])).toEqual(["im:chat.members:read"]);
    expect(new URL(opened[0] as string).origin).toBe("https://open.larksuite.com");
  });

  it("an unreadable permission list is said, and the console opens with every agent scope", async () => {
    const { result, notes, opened } = await check("feishu", async () => {
      throw new Error("HTTP 403");
    });
    expect(result).toEqual({ publishReady: false });
    expect(notes).toMatch(/could not read the feishu app's permissions: Error: HTTP 403/);
    expect(requested(opened[0])).toEqual(AGENT_SCOPES);
  });
});

describe("Feishu app creation addons", () => {
  it("asks for every agent scope on the confirm page, so a tenant that grants them needs no console visit", () => {
    expect(feishuAppAddons().scopes.tenant).toEqual(expect.arrayContaining(AGENT_SCOPES));
  });

  it("requests the app-config scope for either ingress — a WebSocket app can still move to webhook", () => {
    // The scope only webhook USES on day one, requested for both: changing ingress is a migration the
    // CLI refuses to perform, so an app that was not born with it has to be repaired by hand.
    expect(feishuAppAddons().scopes.tenant).toContain(FEISHU_APP_CONFIG_SCOPE);
  });

  it("subscribes the inbound message event — an app that cannot hear one serves nothing", () => {
    expect(feishuAppAddons().events.items.tenant).toContain(FEISHU_MESSAGE_RECEIVE_EVENT);
  });
});
