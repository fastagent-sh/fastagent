import { BUFFER_LINE_MAX_CHARS } from "../context-buffer.ts";
import { codePointPrefix, truncateCodePointPrefix } from "../text.ts";
import type { SlackEventEnvelope, SlackMessageEvent, SlackRoute } from "./model.ts";

export type { SlackEventEnvelope, SlackFile, SlackMessageEvent, SlackRoute } from "./model.ts";

const HUMAN_MESSAGE_SUBTYPES = new Set(["file_share", "thread_broadcast"]);

/**
 * Both forms Slack writes a mention in: `<@U123>` and the labelled `<@U123|name>`. ONE definition,
 * because the forms have to agree across every site that reads them — the "@-mentions only other
 * people is discussion" guard, the structural bot-summon check, the stop-command strip, and the
 * assistant-thread title. They drifted once: widening the first two while the strip still matched only
 * the bare form turned `<@bot|name> stop` into an ordinary turn, queued behind the run it meant to stop.
 */
const mentionSource = (idPattern: string): string => String.raw`<@${idPattern}(?:\|[^>]*)?>`;
const USER_MENTION = mentionSource("[A-Z0-9]+");
/** Broadcasts and user groups address people too: `<!here>`, `<!channel>`, `<!everyone>`,
 *  `<!subteam^S123|@team>`. Feishu's twin guard counts every mention, and the summon rule is supposed
 *  to be the same on both — without these, "@here can someone look at this" in a thread the agent takes
 *  part in reads as a bare message addressed to IT, and gets answered. */
const ANY_MENTION = String.raw`(?:${USER_MENTION}|<!(?:here|channel|everyone)(?:\|[^>]*)?>|<!subteam\^[^>]*>)`;

/** Does this text address ANYONE — a user, a broadcast, or a user group? The §3 discussion guard. */
export function hasSlackMention(text: string): boolean {
  return new RegExp(ANY_MENTION, "i").test(text);
}

/** Does this text mention a USER? Distinct from the above because only a user mention can be the bot:
 *  a broadcast never is, so it must not make a message look like a possible summon. */
export function hasSlackUserMention(text: string): boolean {
  return new RegExp(USER_MENTION, "i").test(text);
}

/** Escape a platform-supplied id before it becomes part of a pattern. Slack ids are alphanumeric in
 *  practice, but `auth.test`'s value is not validated here, and this runs on every group message: an
 *  unescaped metacharacter would either mis-answer the summon question or throw on the acceptance
 *  path, which Slack answers with an endless redelivery. */
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Does this text mention this specific user (either form)? The id is MATCHED, not interpreted. */
export function mentionsSlackUser(text: string, userId: string): boolean {
  return new RegExp(mentionSource(escapeRegExp(userId)), "i").test(text);
}

/** Strip every mention, e.g. before matching a bare command word or building a title. */
export function stripSlackMentions(text: string, replacement = " "): string {
  return text.replace(new RegExp(ANY_MENTION, "gi"), replacement);
}

/** Slack message events whose content represents a new human message rather than a mutation/service event. */
export function isSlackHumanMessage(
  event: SlackMessageEvent | undefined,
): event is SlackMessageEvent & { channel: string; ts: string; user: string } {
  if (!event || (event.type !== "message" && event.type !== "app_mention")) return false;
  if (!event.channel || !event.ts || !event.user || event.bot_id || event.hidden) return false;
  return event.subtype === undefined || HUMAN_MESSAGE_SUBTYPES.has(event.subtype);
}

export function isSlackDirectMessage(event: SlackMessageEvent): boolean {
  return event.channel_type === "im";
}

export function isSlackGroupMessage(event: SlackMessageEvent): boolean {
  return !isSlackDirectMessage(event) && (event.type === "app_mention" || event.channel_type !== undefined);
}

/** Stable install identity. Events API normally supplies team_id; the fallbacks cover Grid envelopes. */
export function slackTeamId(envelope: SlackEventEnvelope): string | undefined {
  return (
    envelope.team_id ??
    envelope.event?.team ??
    envelope.authorizations?.find((authorization) => authorization.team_id)?.team_id ??
    envelope.context_team_id ??
    envelope.enterprise_id ??
    envelope.authorizations?.find((authorization) => authorization.enterprise_id)?.enterprise_id
  );
}

export function slackFileIds(event: SlackMessageEvent): string[] {
  return [...new Set((event.files ?? []).flatMap((file) => (typeof file.id === "string" ? [file.id] : [])))];
}

/** Text plus a structural marker for file-only or captioned file shares. */
export function slackMessageText(event: SlackMessageEvent): string {
  const text = event.text?.trim() ?? "";
  const files = slackFileIds(event).length;
  if (files === 0) return text;
  const marker = `[${files} attached file${files === 1 ? "" : "s"}]`;
  return text ? `${text}\n${marker}` : marker;
}

export function slackSenderLabel(event: SlackMessageEvent): string {
  return `user ${event.user ?? "unknown"}`;
}

/** Main-channel discussion and each concrete thread are independent context buckets.
 *
 *  The `:root:` segment carries `thread_ts`, which in Slack IS the thread's parent message and is
 *  stable for the life of the thread — unrelated to the `<chat>:root:<root_id>` shape Feishu retired
 *  (its `root_id` moves with the reply chain, so it could not identify a side conversation at all).
 *  Same token, different platform meaning; the key is left as-is because renaming it would discard
 *  live context buckets for no semantic gain. */
export function slackPlaceKey(teamId: string, event: Pick<SlackMessageEvent, "channel" | "thread_ts">): string {
  const base = `${teamId}:${event.channel ?? "unknown-channel"}`;
  return event.thread_ts ? `${base}:root:${event.thread_ts}` : base;
}

export function slackBufferText(text: string): string {
  return truncateCodePointPrefix(text.replace(/\s+/g, " ").trim(), BUFFER_LINE_MAX_CHARS);
}

/** Canonical prompt envelope. The channel/thread ids also give slack-send an explicit delivery target. */
export function slackEnvelope(envelope: SlackEventEnvelope): string {
  const event = envelope.event;
  if (!event?.channel) return "";
  const team = slackTeamId(envelope) ?? "unknown-team";
  const direct = isSlackDirectMessage(event);
  const meta = [
    `team ${team}`,
    `channel ${event.channel} (${direct ? "direct" : "group"})`,
    event.thread_ts ? `thread ${event.thread_ts}` : undefined,
    event.ts ? `msg ${event.ts}` : undefined,
    event.user ? `from user ${event.user}` : undefined,
  ]
    .filter(Boolean)
    .join(", ");
  const activeContext = (event.app_context?.entities ?? [])
    .filter((entity) => entity.type && entity.value)
    .slice(0, 5)
    .map(
      (entity) =>
        `${codePointPrefix(String(entity.type).replace(/\s+/g, " "), 80)}=` +
        codePointPrefix(String(entity.value).replace(/\s+/g, " "), 200),
    )
    .join(", ");
  const scope = direct ? "" : "\n[group chat — multiple people; recent discussion is sender-prefixed]";
  const context = activeContext ? `\n[Slack context currently open for the user: ${activeContext}]` : "";
  return `[slack: ${meta}]${scope}${context}\n${slackMessageText(event)}`;
}

/** Default explicit-summon policy: DMs and app_mention events only. */
export function defaultSlackRoute(envelope: SlackEventEnvelope): SlackRoute | null {
  const event = envelope.event;
  if (!isSlackHumanMessage(event)) return null;
  return isSlackDirectMessage(event) || event.type === "app_mention" ? {} : null;
}
