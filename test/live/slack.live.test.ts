/**
 * The Slack Bot API contract, against the real API. `slack-api.ts` is our own pipeline over a
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
 * Needs a long-lived bot token (the only kind the channel takes) and a channel the bot has joined.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createSlackApi, SlackApiError } from "../../src/channels/slack/slack-api.ts";
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

  it("posts markdown through the markdown_text path", async () => {
    // postMarkdown builds a different request body than postMessage (markdown_text, not text), and it
    // is the one every agent reply actually goes through.
    const ts = await api.postMarkdown({ channelId: CHANNEL }, `**fastagent** live probe \`${randomUUID()}\``);
    posted.push(ts);
    expect(ts).toMatch(/^\d+\.\d+$/);
  });

  it("surfaces an API rejection as an error instead of a silent no-op", async () => {
    // Slack answers `{ ok: false, error: "channel_not_found" }` with HTTP 200. A pipeline that only
    // checked the status would treat this as success and lose every message sent to a bad channel.
    // Asserted on the ENVELOPE, not merely on "it threw": a transport failure (an unreachable proxy,
    // a timeout) arrives as status 0 or as something that is not a SlackApiError at all, and a bare
    // `rejects.toThrow()` would count those as coverage. Not pinned to the literal `channel_not_found`
    // — Slack may answer a malformed id with another code, and an `ok:false` code on HTTP 200 is the
    // whole claim. A dead TOKEN still satisfies this shape (`invalid_auth` rides the same envelope);
    // the three tests above are what fail then, and that is the right division of labour.
    const error = await api.postMessage({ channelId: "C000000000000" }, "should not arrive").catch((e) => e);
    expect(error, "a Slack rejection must arrive as SlackApiError").toBeInstanceOf(SlackApiError);
    expect(error.status, "the ok:false envelope rides on HTTP 200").toBe(200);
    expect(error.slackError, "no Slack error code on the rejection").toBeTruthy();
  });
});
