export type SlackGroupBehavior = "context" | "mentions";

const SLACK_BASE_BOT_SCOPES = [
  "app_mentions:read",
  "assistant:write",
  "chat:write",
  "files:read",
  "files:write",
  "im:history",
  "reactions:write",
] as const;
const SLACK_CONTEXT_BOT_SCOPES = ["channels:history", "groups:history", "mpim:history"] as const;
const SLACK_BASE_BOT_EVENTS = ["app_context_changed", "app_home_opened", "app_mention", "message.im"] as const;
const SLACK_CONTEXT_BOT_EVENTS = ["message.channels", "message.groups", "message.mpim"] as const;

export interface SlackAppManifest {
  display_information: {
    name: string;
    description: string;
    background_color: string;
  };
  features: {
    app_home: {
      home_tab_enabled: boolean;
      messages_tab_enabled: boolean;
      messages_tab_read_only_enabled: boolean;
    };
    agent_view: {
      agent_description: string;
      suggested_prompts: Array<{ title: string; message: string }>;
    };
    bot_user: { display_name: string; always_online: boolean };
  };
  oauth_config: {
    scopes: { bot: string[] };
    redirect_urls?: string[];
  };
  settings: {
    /** All-or-nothing: Slack rejects a subscription with no `request_url` unless Socket Mode is on. */
    event_subscriptions?: { request_url: string; bot_events: string[] };
    org_deploy_enabled: boolean;
    socket_mode_enabled: boolean;
    token_rotation_enabled: boolean;
  };
}

export function slackBotScopes(groupBehavior: SlackGroupBehavior): string[] {
  return [...SLACK_BASE_BOT_SCOPES, ...(groupBehavior === "context" ? SLACK_CONTEXT_BOT_SCOPES : [])].sort();
}

export function slackBotEvents(groupBehavior: SlackGroupBehavior): string[] {
  return [...SLACK_BASE_BOT_EVENTS, ...(groupBehavior === "context" ? SLACK_CONTEXT_BOT_EVENTS : [])].sort();
}

/** Slack's bot display name is more restrictive than the app name. */
function slackBotDisplayName(name: string): string {
  const normalized = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
    .slice(0, 80);
  return normalized || "fastagent";
}

export function buildSlackManifest(input: {
  name: string;
  groupBehavior: SlackGroupBehavior;
  requestUrl?: string;
  redirectUrl?: string;
  /** Rotating bot tokens need an OAuth redirect URL to be issued through. A console install has none,
   *  so `add slack --manual` builds the app without rotation and the channel reads a static token
   *  (bot-auth.ts serves one when the rotation fields are absent). Defaults to on. */
  tokenRotation?: boolean;
}): SlackAppManifest {
  const name = input.name.trim().slice(0, 35) || "FastAgent";
  return {
    display_information: {
      name,
      description: "A FastAgent-powered internal workspace agent.",
      background_color: "#111827",
    },
    features: {
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      agent_view: {
        agent_description: "A workspace agent powered by the files, skills, and tools in its FastAgent definition.",
        suggested_prompts: [
          { title: "What can you do?", message: "What can you help me with?" },
          { title: "Summarize context", message: "Summarize the relevant context and propose next steps." },
        ],
      },
      bot_user: { display_name: slackBotDisplayName(name), always_online: false },
    },
    oauth_config: {
      scopes: { bot: slackBotScopes(input.groupBehavior) },
      ...(input.redirectUrl ? { redirect_urls: [input.redirectUrl] } : {}),
    },
    settings: {
      // Subscription and URL travel TOGETHER because Slack requires it: `apps.manifest.create` rejects
      // `event_subscriptions` without a `request_url` ("requires Socket Mode if no Request URL is
      // provided"), verified against the real API. So an app created before a public URL exists
      // subscribes to nothing yet — and the update that later sets `request_url` carries `bot_events`
      // in the same manifest, which is what keeps that temporary gap from becoming a silent one.
      ...(input.requestUrl
        ? {
            event_subscriptions: {
              request_url: input.requestUrl,
              bot_events: slackBotEvents(input.groupBehavior),
            },
          }
        : {}),
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: input.tokenRotation ?? true,
    },
  };
}
