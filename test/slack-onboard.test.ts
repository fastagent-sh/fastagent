import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSlackApp, exchangeSlackOAuthCode } from "../src/channels/slack/config-api.ts";
import { buildSlackManifest, slackBotEvents, slackBotScopes } from "../src/channels/slack/manifest.ts";
import { newSlackOnboardingState, onboardSlackApp } from "../src/channels/slack/onboard.ts";
import {
  currentSlackConfigToken,
  readSlackOnboardingState,
  writeSlackOnboardingState,
} from "../src/channels/slack/onboarding-state.ts";
import { registerSlackWebhook } from "../src/channels/slack/register-webhook.ts";
import { startSlackSetupServer } from "../src/channels/slack/setup-server.ts";

const roots: string[] = [];

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "fa-slack-onboard-"));
  roots.push(value);
  return value;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe("Slack internal-app manifest and control API", () => {
  it("keeps mention-only least privilege and adds context history/events explicitly", () => {
    expect(slackBotScopes("mentions")).toEqual([
      "app_mentions:read",
      "assistant:write",
      "chat:write",
      "files:read",
      "files:write",
      "im:history",
      "reactions:write",
    ]);
    expect(slackBotEvents("mentions")).toEqual(["app_context_changed", "app_home_opened", "app_mention", "message.im"]);
    expect(slackBotScopes("context")).toEqual(
      expect.arrayContaining(["channels:history", "groups:history", "mpim:history"]),
    );
    expect(slackBotEvents("context")).toEqual(
      expect.arrayContaining(["message.channels", "message.groups", "message.mpim"]),
    );

    const manifest = buildSlackManifest({
      name: "My Internal Agent",
      groupBehavior: "context",
      requestUrl: "https://agent.test/slack",
      redirectUrl: "https://agent.test/oauth",
    });
    expect(manifest.features.app_home).toMatchObject({
      messages_tab_enabled: true,
      messages_tab_read_only_enabled: false,
    });
    expect(manifest.features.agent_view).toMatchObject({
      agent_description: expect.any(String),
      suggested_prompts: expect.any(Array),
    });
    expect(manifest.settings).toMatchObject({
      socket_mode_enabled: false,
      token_rotation_enabled: true,
      event_subscriptions: { request_url: "https://agent.test/slack" },
    });
  });

  it("sends manifest credentials only in headers/body and parses create + OAuth results", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          app_id: "A1",
          credentials: { client_id: "C1", client_secret: "secret", signing_secret: "sign" },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          access_token: "xoxe.xoxb-bot",
          refresh_token: "xoxe-bot-refresh",
          expires_in: 43_200,
          app_id: "A1",
          scope: slackBotScopes("mentions").join(","),
          team: { id: "T1", name: "Acme" },
        }),
      );
    const manifest = buildSlackManifest({ name: "Agent", groupBehavior: "mentions" });
    await expect(createSlackApp("xoxe.config", manifest, { fetch: fetchMock })).resolves.toMatchObject({
      appId: "A1",
      clientSecret: "secret",
      signingSecret: "sign",
    });
    const createInit = fetchMock.mock.calls[0]?.[1];
    expect(createInit?.headers).toMatchObject({ authorization: "Bearer xoxe.config" });
    expect(JSON.parse(String(createInit?.body))).toMatchObject({ manifest: expect.any(String) });

    await expect(
      exchangeSlackOAuthCode(
        { clientId: "C1", clientSecret: "secret", code: "code", redirectUrl: "https://agent.test/oauth" },
        { fetch: fetchMock },
      ),
    ).resolves.toMatchObject({
      botToken: "xoxe.xoxb-bot",
      botRefreshToken: "xoxe-bot-refresh",
      appId: "A1",
      teamId: "T1",
    });
    const oauthInit = fetchMock.mock.calls[1]?.[1];
    expect(oauthInit?.headers).toMatchObject({
      authorization: `Basic ${Buffer.from("C1:secret").toString("base64")}`,
    });
    expect(String(oauthInit?.body)).not.toContain("secret");
  });

  it("never includes OAuth response fields in a rejected exchange error", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json(
        {
          ok: false,
          error: "bad_client_secret",
          access_token: "xoxb-must-not-escape",
          team: { id: "T1", name: "Private Workspace" },
        },
        { status: 401 },
      ),
    );

    const error = await exchangeSlackOAuthCode(
      { clientId: "C1", clientSecret: "secret", code: "code", redirectUrl: "https://agent.test/oauth" },
      { fetch: fetchMock },
    ).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/rejected the app client secret.*HTTP 401/);
    expect((error as Error).message).not.toMatch(/xoxb|Private Workspace|T1/);
  });
});

describe("Slack internal-app onboarding", () => {
  it("persists the irreversible app boundary, validates OAuth state/scopes, and drops the client secret", async () => {
    const stateRoot = await root();
    const initial = newSlackOnboardingState({
      appName: "Agent",
      groupBehavior: "mentions",
      configToken: "xoxe.config",
      configRefreshToken: "xoxe-refresh",
    });
    await writeSlackOnboardingState(stateRoot, initial);
    let oauthState = "";
    const secrets: { botToken?: string; signingSecret?: string }[] = [];

    const result = await onboardSlackApp(
      {
        stateRoot,
        state: initial,
        requestUrl: "https://setup.test/request",
        redirectUrl: "https://setup.test/oauth",
      },
      {
        note: () => {},
        openUrl(url) {
          oauthState = new URL(url).searchParams.get("state") ?? "";
        },
        waitForOAuth: async () => ({ code: "oauth-code", state: oauthState }),
        writeRuntimeSecrets: async (values) => {
          secrets.push(values);
        },
      },
      {
        createApp: async () => ({
          appId: "A1",
          clientId: "C1",
          clientSecret: "client-secret",
          signingSecret: "signing-secret",
        }),
        exchangeCode: async () => ({
          botToken: "xoxe.xoxb-bot",
          botRefreshToken: "xoxe-bot-refresh",
          botTokenExpiresAt: 2_000_000_000_000,
          appId: "A1",
          teamId: "T1",
          teamName: "Acme",
          scopes: slackBotScopes("mentions"),
        }),
      },
    );

    expect(secrets).toEqual([
      { signingSecret: "signing-secret" },
      {
        botToken: "xoxe.xoxb-bot",
        botRefreshToken: "xoxe-bot-refresh",
        botTokenExpiresAt: 2_000_000_000_000,
        clientId: "C1",
        clientSecret: "client-secret",
      },
    ]);
    expect(result).toMatchObject({ appId: "A1", teamId: "T1", teamName: "Acme" });
    expect(result.clientSecret).toBeUndefined();
    const persisted = await readSlackOnboardingState(stateRoot);
    expect(persisted?.clientSecret).toBeUndefined();
    expect(persisted?.installedAt).toBeTruthy();
    expect((await stat(join(stateRoot, "channels", "slack", "onboarding.json"))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(stateRoot, "channels", "slack", "onboarding.json"), "utf8")).not.toContain(
      "client-secret",
    );
  });

  it("blocks a blind duplicate create after an ambiguous create response", async () => {
    const stateRoot = await root();
    const initial = newSlackOnboardingState({
      appName: "Agent",
      groupBehavior: "mentions",
      configToken: "xoxe.config",
      configRefreshToken: "xoxe-refresh",
    });
    await writeSlackOnboardingState(stateRoot, initial);
    const createApp = vi.fn(async () => {
      throw new Error("connection reset after request");
    });
    const io = {
      note: () => {},
      openUrl: () => {},
      waitForOAuth: async () => ({ code: "unused", state: "unused" }),
      writeRuntimeSecrets: async () => {},
    };
    const input = {
      stateRoot,
      state: initial,
      requestUrl: "https://setup.test/request",
      redirectUrl: "https://setup.test/oauth",
    };
    await expect(onboardSlackApp(input, io, { createApp })).rejects.toThrow(/connection reset/);
    const attempted = await readSlackOnboardingState(stateRoot);
    expect(attempted?.createAttemptedAt).toBeTruthy();
    await expect(onboardSlackApp({ ...input, state: attempted! }, io, { createApp })).rejects.toThrow(
      /Inspect https:\/\/api.slack.com\/apps/,
    );
    expect(createApp).toHaveBeenCalledOnce();
  });

  it("rotates expiring config credentials atomically and persists the replacement refresh token", async () => {
    const stateRoot = await root();
    const state = {
      ...newSlackOnboardingState({
        appName: "Agent",
        groupBehavior: "mentions",
        configToken: "xoxe.old",
        configRefreshToken: "xoxe-old-refresh",
      }),
      configTokenExpiresAt: 0,
    };
    await writeSlackOnboardingState(stateRoot, state);
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        ok: true,
        token: "xoxe.new",
        refresh_token: "xoxe-new-refresh",
        exp: 2_000_000_000,
        team_id: "T1",
      }),
    );
    await expect(currentSlackConfigToken(stateRoot, state, { now: 1_000, fetch: fetchMock })).resolves.toMatchObject({
      token: "xoxe.new",
      state: { configRefreshToken: "xoxe-new-refresh", teamId: "T1" },
    });
    expect((await readSlackOnboardingState(stateRoot))?.configRefreshToken).toBe("xoxe-new-refresh");
  });

  it("rejects a forged OAuth callback state before exchanging the code", async () => {
    const stateRoot = await root();
    const state = {
      ...newSlackOnboardingState({
        appName: "Agent",
        groupBehavior: "mentions" as const,
        configToken: "xoxe.config",
        configRefreshToken: "xoxe-refresh",
      }),
      appId: "A1",
      clientId: "C1",
      clientSecret: "secret",
    };
    await writeSlackOnboardingState(stateRoot, state);
    const exchangeCode = vi.fn();
    await expect(
      onboardSlackApp(
        { stateRoot, state, requestUrl: "https://setup.test/request", redirectUrl: "https://setup.test/oauth" },
        {
          note: () => {},
          openUrl: () => {},
          waitForOAuth: async () => ({ code: "code", state: "forged" }),
          writeRuntimeSecrets: async () => {},
        },
        { updateManifest: async () => {}, exchangeCode },
      ),
    ).rejects.toThrow(/state mismatch/);
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("serves only the temporary challenge and one OAuth callback", async () => {
    const server = await startSlackSetupServer();
    try {
      const origin = `http://127.0.0.1:${server.port}`;
      const challenge = await fetch(`${origin}${server.requestPath}`, {
        method: "POST",
        body: JSON.stringify({ type: "url_verification", challenge: "abc" }),
      });
      expect(await challenge.json()).toEqual({ challenge: "abc" });
      expect((await fetch(`${origin}${server.requestPath}`, { method: "POST", body: "{}" })).status).toBe(404);
      await fetch(`${origin}${server.redirectPath}?code=code&state=state`);
      await expect(server.waitForOAuth()).resolves.toEqual({ code: "code", state: "state", error: undefined });
    } finally {
      await server.close();
    }
  });
});

describe("Slack Request URL registration", () => {
  it("degrades to a truthful manual step without local onboarding state", async () => {
    const stateRoot = await root();
    const logs: string[] = [];
    await expect(
      registerSlackWebhook("https://agent.test", { stateRoot, log: (line) => logs.push(line) }),
    ).resolves.toBe("manual");
    expect(logs.join("\n")).toContain("https://agent.test/slack");
  });

  it("updates an onboarded app from the local machine without deploying the config token", async () => {
    const stateRoot = await root();
    await writeSlackOnboardingState(stateRoot, {
      ...newSlackOnboardingState({
        appName: "Agent",
        groupBehavior: "context",
        configToken: "xoxe.config",
        configRefreshToken: "xoxe-refresh",
      }),
      appId: "A1",
      installedAt: new Date().toISOString(),
    });
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith("/health")) return new Response("ok");
      expect(init?.headers).toMatchObject({ authorization: "Bearer xoxe.config" });
      const body = JSON.parse(String(init?.body)) as { app_id: string; manifest: string };
      expect(body.app_id).toBe("A1");
      expect(JSON.parse(body.manifest)).toMatchObject({
        oauth_config: { redirect_urls: ["https://agent.test/slack/oauth/callback"] },
        settings: {
          event_subscriptions: { request_url: "https://agent.test/slack" },
          token_rotation_enabled: true,
        },
      });
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      registerSlackWebhook("https://agent.test", { stateRoot, fetch: fetchMock, healthTimeoutMs: 1 }),
    ).resolves.toBe("registered");
  });
});
