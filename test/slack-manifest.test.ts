import { describe, expect, it } from "vitest";
import { buildSlackManifest, slackManifestLink } from "../src/channels/slack/manifest.ts";

describe("slack manifest", () => {
  it("a Socket Mode app subscribes to events with no Request URL, and receives over the socket alone", () => {
    const manifest = buildSlackManifest({ name: "FastAgent bot", ingress: "connection" });
    expect(manifest.settings.socket_mode_enabled).toBe(true);
    expect(manifest.settings.event_subscriptions.request_url).toBeUndefined();
    expect(manifest.settings.event_subscriptions.bot_events).toEqual(
      expect.arrayContaining(["app_mention", "message.im", "message.channels", "app_home_opened"]),
    );
  });

  it("a webhook app carries the Request URL: Slack refuses a manifest that subscribes to events without one", () => {
    const manifest = buildSlackManifest({
      name: "FastAgent bot",
      ingress: "webhook",
      requestUrl: "https://agent.acme.com/slack",
    });
    expect(manifest.settings.socket_mode_enabled).toBe(false);
    expect(manifest.settings.event_subscriptions.request_url).toBe("https://agent.acme.com/slack");
  });

  it("is one app either way: the same scopes, rotation off, a bot, the Messages tab, and a name Slack accepts", () => {
    const connection = buildSlackManifest({ name: "x".repeat(60), ingress: "connection" });
    const webhook = buildSlackManifest({ name: "FastAgent Bot!", ingress: "webhook", requestUrl: "https://a/slack" });
    expect(connection.oauth_config.scopes).toEqual(webhook.oauth_config.scopes);
    expect(connection.oauth_config.scopes.bot).toEqual(
      expect.arrayContaining(["chat:write", "users:read", "channels:history", "assistant:write"]),
    );
    for (const manifest of [connection, webhook]) {
      expect(manifest.settings.token_rotation_enabled).toBe(false);
      expect(manifest.features.app_home.messages_tab_enabled).toBe(true);
    }
    expect(connection.display_information.name).toHaveLength(35);
    expect(webhook.features.bot_user.display_name).toBe("fastagent-bot");
  });

  it("the link carries the whole manifest, which is what the page's JSON editor then holds", () => {
    const manifest = buildSlackManifest({ name: "FastAgent bot", ingress: "connection" });
    const link = new URL(slackManifestLink(manifest));
    expect(`${link.origin}${link.pathname}`).toBe("https://api.slack.com/apps");
    expect(link.searchParams.get("new_app")).toBe("1");
    expect(JSON.parse(link.searchParams.get("manifest_json") as string)).toEqual(manifest);
    // Slack takes a link this long; a manifest that grows past a few KB is a sign to look at the others (measured 1.7 KB).
    expect(link.href.length).toBeLessThan(3000);
  });
});
