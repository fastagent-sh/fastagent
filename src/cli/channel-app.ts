/**
 * The binding of a channel whose URL only a person sets (Slack; Lark without its configuration API), recorded in an
 * instance configuration once the deployment confirms the URL (`channels.<name>.app`): what `deploy` at a
 * terminal and `channels setup --record-url` both write.
 */
import { setChannelConfig } from "../authoring.ts";
import { createSlackApi } from "../channels/slack/slack-api.ts";
import type { WebhookKind } from "../channels/webhooks.ts";

/**
 * The app a recorded URL belongs to: Lark's App ID from its values; Slack's from its bot token, which names the app a
 * bot belongs to (`bots.info`, which needs the `users:read` scope the app is created with).
 */
async function appOf(
  kind: "slack" | "lark",
  values: ReadonlyMap<string, string>,
): Promise<{ id: string; team?: string }> {
  if (kind === "lark") {
    const id = values.get("LARK_APP_ID");
    if (!id) throw new Error("lark: no LARK_APP_ID in the values, so the URL cannot be recorded against its app");
    return { id };
  }
  const botToken = values.get("SLACK_BOT_TOKEN");
  if (!botToken)
    throw new Error("slack: no SLACK_BOT_TOKEN in the values, so the URL cannot be recorded against its app");
  const api = createSlackApi({ botToken });
  const { teamId, botId } = await api.authTest();
  const id = botId === undefined ? undefined : await api.botAppId(botId);
  if (id === undefined) throw new Error("slack: Slack named no app for this bot token (does it hold users:read?)");
  return { id, ...(teamId === undefined ? {} : { team: teamId }) };
}

/** Record `url` as the confirmed URL of `kind`'s app in the configuration file `config`. */
export async function recordChannelUrl(
  agentDir: string,
  config: string,
  kind: WebhookKind,
  url: string,
  values: ReadonlyMap<string, string>,
): Promise<void> {
  if (kind !== "slack" && kind !== "lark") {
    throw new Error(`${kind}: its URL the instance sets itself, so there is nothing to record`);
  }
  await setChannelConfig(agentDir, kind, { app: { ...(await appOf(kind, values)), url } }, { config });
}
