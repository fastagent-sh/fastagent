import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSlackBotTokenProvider, readSlackBotAuthEnv } from "../src/channels/slack/bot-auth.ts";

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "fa-slack-bot-auth-"));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("Slack rotating bot credentials", () => {
  it("refreshes once under concurrency and persists the replacement pair owner-only", async () => {
    const statePath = join(root(), "channels", "slack", "bot-auth.json");
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Basic ${Buffer.from("client:secret").toString("base64")}`,
      );
      expect(String(init?.body)).toContain("grant_type=refresh_token");
      expect(String(init?.body)).toContain("refresh_token=xoxe-old-refresh");
      return Response.json({
        ok: true,
        access_token: "xoxe.xoxb-new",
        refresh_token: "xoxe-new-refresh",
        expires_in: 43_200,
      });
    });
    const token = createSlackBotTokenProvider({
      statePath,
      botToken: "xoxe.xoxb-old",
      botRefreshToken: "xoxe-old-refresh",
      clientId: "client",
      clientSecret: "secret",
      botTokenExpiresAt: Date.now() - 1,
      apiBaseUrl: "https://slack.test/api",
      fetch: fetchMock,
    });

    await expect(Promise.all([token(), token(), token()])).resolves.toEqual([
      "xoxe.xoxb-new",
      "xoxe.xoxb-new",
      "xoxe.xoxb-new",
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({
      accessToken: "xoxe.xoxb-new",
      refreshToken: "xoxe-new-refresh",
    });
    expect(readSlackBotAuthEnv(statePath)).toMatchObject({
      SLACK_BOT_TOKEN: "xoxe.xoxb-new",
      SLACK_BOT_REFRESH_TOKEN: "xoxe-new-refresh",
    });

    const afterRestart = createSlackBotTokenProvider({
      statePath,
      botToken: "stale-env-access",
      botRefreshToken: "stale-env-refresh",
      clientId: "client",
      clientSecret: "secret",
      botTokenExpiresAt: Date.now() - 1,
      fetch: vi.fn(() => Promise.reject(new Error("must not refresh"))),
    });
    await expect(afterRestart()).resolves.toBe("xoxe.xoxb-new");

    const newerDeployPair = createSlackBotTokenProvider({
      statePath,
      botToken: "xoxe.xoxb-from-deploy",
      botRefreshToken: "xoxe-deploy-refresh",
      clientId: "client",
      clientSecret: "secret",
      botTokenExpiresAt: Date.now() + 2 * 24 * 60 * 60_000,
    });
    await expect(newerDeployPair()).resolves.toBe("xoxe.xoxb-from-deploy");
  });

  it("supports manual long-lived tokens but rejects a partial rotation configuration", async () => {
    const statePath = join(root(), "bot-auth.json");
    await expect(createSlackBotTokenProvider({ statePath, botToken: "xoxb-long-lived" })()).resolves.toBe(
      "xoxb-long-lived",
    );
    expect(() =>
      createSlackBotTokenProvider({
        statePath,
        botToken: "xoxe.xoxb-access",
        botRefreshToken: "xoxe-refresh",
      }),
    ).toThrow(/requires botRefreshToken, clientId, clientSecret, and botTokenExpiresAt together/);
  });
});
