/**
 * What a Slack app's setup asks for (channels/setup.ts). The app is created from a manifest link the person opens, so
 * its scopes, events and Socket Mode switch are what FastAgent needs; the values only they can read off its pages are
 * pasted: the bot token and the app-level token Socket Mode connects with.
 */
import { type ChannelSetup, SetupRefused, pasteOne } from "../setup.ts";
import { buildSlackManifest, slackManifestLink } from "./manifest.ts";
import { SlackApiError, createSlackApi } from "./slack-api.ts";
import { TerminalSocketError, openSlackConnection } from "./socket.ts";

const SLACK_API = "https://slack.com/api";

export const slackSetup: ChannelSetup = ({ appName }) => {
  const manifest = buildSlackManifest({ name: `FastAgent ${appName}` });
  const values = [
    pasteOne({
      name: "SLACK_BOT_TOKEN",
      label: "Bot User OAuth Token",
      guide: {
        instructions:
          "Create the app from this link (pick a workspace, then Create), then open Install App → Install to " +
          "Workspace → Allow, and copy the Bot User OAuth Token.",
        url: slackManifestLink(manifest),
      },
      async check(value) {
        if (value.startsWith("xoxe.")) {
          throw new SetupRefused("That is a rotating token, which FastAgent does not support.", {
            fix: "Token rotation cannot be turned off once it is on: create the app again from the link, which leaves it off.",
          });
        }
        if (!value.startsWith("xoxb-")) {
          throw new SetupRefused("That is not a bot token.", {
            fix: "The Bot User OAuth Token is under Install App, and starts with xoxb-.",
          });
        }
        try {
          const api = createSlackApi({ botToken: value, baseUrl: SLACK_API });
          const identity = await api.authTest();
          return `bot in workspace ${identity.teamId ?? "(unknown)"}`;
        } catch (error) {
          if (error instanceof SlackApiError && error.status === 200) {
            throw new SetupRefused("Slack does not accept this token.", {
              fix: "Copy the Bot User OAuth Token again from Install App.",
              why: error.message,
            });
          }
          throw error;
        }
      },
    }),
    pasteOne({
      name: "SLACK_APP_TOKEN",
      label: "App-Level Token",
      guide: {
        instructions:
          "Open Basic Information → App-Level Tokens → Generate Token and Scopes, add the scope " +
          "connections:write, and copy the token.",
      },
      async check(value: string) {
        if (!value.startsWith("xapp-")) {
          throw new SetupRefused("That is not an app-level token.", {
            fix: "It starts with xapp-, and is made under Basic Information → App-Level Tokens (not the bot token).",
          });
        }
        try {
          await openSlackConnection(SLACK_API, value);
          return undefined;
        } catch (error) {
          if (error instanceof TerminalSocketError) {
            throw new SetupRefused("Slack does not accept this token.", {
              fix: "Make sure it has the connections:write scope, and copy it again.",
              why: error.message,
            });
          }
          throw error;
        }
      },
    }),
  ];
  return {
    values,
    finish: () => ["invite the app to each channel it should read (/invite @<its name> in the channel)"],
  };
};
