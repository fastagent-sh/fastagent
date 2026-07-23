import { codePointPrefix } from "../text.ts";
import type { SlackEventEnvelope, SlackMessageEvent, SlackRoute } from "./model.ts";

export type { SlackEventEnvelope, SlackFile, SlackMessageEvent, SlackRoute } from "./model.ts";

const HUMAN_MESSAGE_SUBTYPES = new Set(["file_share", "thread_broadcast"]);

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

/** Main-channel discussion and each concrete thread are independent context buckets. */
export function slackPlaceKey(teamId: string, event: Pick<SlackMessageEvent, "channel" | "thread_ts">): string {
  const base = `${teamId}:${event.channel ?? "unknown-channel"}`;
  return event.thread_ts ? `${base}:root:${event.thread_ts}` : base;
}

export function slackBufferText(text: string): string {
  return codePointPrefix(text.replace(/\s+/g, " ").trim(), 280);
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
