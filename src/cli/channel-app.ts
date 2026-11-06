/**
 * The binding of a channel whose URL only a person sets (Slack; Lark without its configuration API), recorded in an
 * instance configuration once the deployment confirms the URL (`channels.<name>.app`, SPEC.md §8): what `deploy` at a
 * terminal and `channels setup --record-url` both write.
 */
import { setChannelConfig } from "../authoring.ts";
import { readSlackOnboardingState } from "../channels/slack/onboarding-state.ts";
import type { WebhookKind } from "../channels/webhooks.ts";
import { resolveStateRoot } from "../paths.ts";

/** The app a recorded URL belongs to: Slack's from this machine's onboarding of it, Lark's App ID from its values. */
function appOf(
  agentDir: string,
  kind: "slack" | "lark",
  values: ReadonlyMap<string, string>,
  given?: { id: string; team?: string },
): { id: string; team?: string } {
  if (given !== undefined) return given;
  if (kind === "lark") {
    const id = values.get("LARK_APP_ID");
    if (!id) throw new Error("lark: no LARK_APP_ID in the values, so the URL cannot be recorded against its app");
    return { id };
  }
  const state = readSlackOnboardingState(resolveStateRoot(agentDir));
  if (!state?.appId) {
    throw new Error(
      "slack: no Slack app onboarded on this machine (`fastagent add slack --env production`), so the URL cannot be " +
        "recorded against its app: name it with --app <id> (and --team <id>), from its Basic Information page",
    );
  }
  return { id: state.appId, ...(state.teamId === undefined ? {} : { team: state.teamId }) };
}

/** Record `url` as the confirmed URL of `kind`'s app in the configuration file `config`. */
export async function recordChannelUrl(
  agentDir: string,
  config: string,
  kind: WebhookKind,
  url: string,
  values: ReadonlyMap<string, string>,
  app?: { id: string; team?: string },
): Promise<void> {
  if (kind !== "slack" && kind !== "lark") {
    throw new Error(`${kind}: its URL the instance sets itself, so there is nothing to record`);
  }
  await setChannelConfig(agentDir, kind, { app: { ...appOf(agentDir, kind, values, app), url } }, { config });
}
