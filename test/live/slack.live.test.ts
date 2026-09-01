/**
 * The Slack Bot API contract, against the real API. `slack-api.ts` is our own claude codepeline over a
 * surface Slack owns — argument spelling, response shape, the `ok:false` error envelope — and the
 * offline tests (slack-api.test.ts) drive it against a fake `fetch` that answers what we believe
 * today. This probe is the part that notices when that belief stops matching.
 *
 * SCOPE: OUTBOUND only, and deliberately narrower than the telegram and feishu probes. Those two
 * assert that the platform calls US (setWebhook verification, url_verification challenge). The
 * equivalent for Slack is the Events API, whose Request URL is registered with an App Configuration
 * Token — which expires in 12h and revokes its predecessor on every rotation, so a nightly built on
 * one is red by its second run. Inbound Slack (signature verification, url_verification, delivery)
 * therefore stays offline-only, and this file says so rather than implying coverage it does not have.
 *
 * Needs a bot token WITHOUT token rotation (`createSlackBotTokenProvider` takes the long-lived path
 * when the four rotation fields are absent) and a channel the bot has joined. Rotation is covered
 * offline: slack-bot-auth.test.ts asserts the refresh, its single-flight and its 0600 persistence —
 * CI has no durable volume to catch a refreshed pair, which is exactly why this uses a static token.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createSlackApi } from "../../src/channels/slack/slack-api.ts";
import { installProxyFetch } from "../../src/proxy.ts";
import { requireEnv } from "./env.ts";

// Node's fetch ignores HTTPS_PROXY; every call below is an outbound HTTPS request.
installProxyFetch();

const BOT_TOKEN = requireEnv("SLACK_BOT_TOKEN", "a long-lived xoxb- token for this probe's OWN app");
const CHANNEL = requireEnv("SLACK_TEST_CHANNEL", "a channel id (C…) the probe's bot has been invited to");

const api = createSlackApi({ botToken: BOT_TOKEN });

/** Messages this run posted, removed however it ends — a probe must not leave a channel full of noise. */
const posted: string[] = [];
afterAll(async () => {
  const errors: unknown[] = [];
  for (const ts of posted.reverse()) {
    try {
      await api.deleteMessage(CHANNEL, ts);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "could not delete every probe message");
});

describe("slack Bot API contract", () => {
  it("authenticates and reports this bot's identity", async () => {
    const who = await api.authTest();
    // The fields the channel actually consumes downstream: a response that stopped carrying them
    // would break routing long before anyone noticed a schema change.
    expect(who.teamId, "auth.test returned no team id").toBeTruthy();
    expect(who.userId, "auth.test returned no bot user id").toBeTruthy();
  });

  it("posts a message and gets back a timestamp that addresses it", async () => {
    const marker = randomUUID();
    const ts = await api.postMessage({ channelId: CHANNEL }, `fastagent live probe ${marker}`);
    posted.push(ts);
    // A Slack ts is `<seconds>.<microseconds>` and is the message's address for every later call.
    expect(ts, `unexpected ts shape: ${ts}`).toMatch(/^\d+\.\d+$/);

    // Prove the ts really addresses that message rather than merely looking well-formed: editing
    // through it is the same round trip the live preview makes on every streamed turn.
    await api.updateMessage(CHANNEL, ts, `fastagent live probe ${marker} (edited)`);
  });

  it("posts markdown through the blocks path", async () => {
    // postMarkdown builds a different request body than postMessage (blocks, not text), and it is the
    // one every agent reply actually goes through.
    const ts = await api.postMarkdown({ channelId: CHANNEL }, `**fastagent** live probe \`${randomUUID()}\``);
    posted.push(ts);
    expect(ts).toMatch(/^\d+\.\d+$/);
  });

  it("surfaces an API rejection as an error instead of a silent no-op", async () => {
    // Slack answers `{ ok: false, error: "channel_not_found" }` with HTTP 200. A claude codepeline that only
    // checked the status would treat this as success and lose every message sent to a bad channel.
    await expect(api.postMessage({ channelId: "C000000000000" }, "should not arrive")).rejects.toThrow();
  });
});
