/**
 * What a Lark app's setup asks for (channels/setup.ts). Lark's international cloud cannot complete the bound
 * scan-to-create flow, so its person creates the app on the one-click launcher and pastes the App ID and App Secret,
 * which Lark checks as a pair; the rest is the Feishu engine's.
 */
import { encodeAddons } from "../feishu/register-app.ts";
import { createFeishuApi, isFeishuCredentialsRefused } from "../feishu/feishu-api.ts";
import { feishuEngine } from "../feishu/setup.ts";
import { feishuAppAddons } from "../feishu/setup-mode.ts";
import { type ChannelSetup, SetupRefused, type SetupWay } from "../setup.ts";
import { cloudFor } from "../feishu/cloud.ts";

/**
 * Lark's one-click launcher, where the person creates the app. The launcher is unbound (the bound confirm page is broken
 * on the international cloud), but it merges the `addons` query parameter onto the app it creates, as Feishu's does: the
 * scopes and the event the channel needs arrive with the app, so nothing is ticked in the console afterwards. A tenant
 * may still withhold a scope; the permission check that follows creation names it.
 */
function larkLauncherUrl(way: SetupWay): string {
  const url = new URL("https://open.larksuite.com/page/launcher");
  url.searchParams.set("from", "backend_oneclick");
  url.searchParams.set("addons", encodeAddons(feishuAppAddons(way)));
  return url.toString();
}

export const larkSetup: ChannelSetup = (context) =>
  feishuEngine(
    "lark",
    {
      kind: "paste",
      label: "App ID and App Secret",
      guide: {
        instructions:
          "Create the app on Lark's one-click launcher (it comes with the scopes and the event the channel needs), " +
          "then copy its App ID and App Secret from Credentials & Basic Info.",
        url: larkLauncherUrl(context.way),
      },
      fields: [
        { name: "LARK_APP_ID", label: "App ID", secret: false },
        { name: "LARK_APP_SECRET", label: "App Secret" },
      ],
      async check(values) {
        const api = createFeishuApi({
          kind: "lark",
          baseUrl: cloudFor("lark").apiBase,
          appId: values.LARK_APP_ID as string,
          appSecret: values.LARK_APP_SECRET as string,
        });
        try {
          await api.verifyCredentials();
          return undefined;
        } catch (error) {
          // Only a known credential refusal is a wrong pair; the network and the platform being down end the setup.
          if (!isFeishuCredentialsRefused(error)) throw error;
          throw new SetupRefused("Lark refused that App ID or Secret.", {
            fix: "Copy both again from Credentials & Basic Info.",
            why: `Lark said: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      },
    },
    context,
  );
