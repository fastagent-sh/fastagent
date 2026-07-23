/** Minimal Slack Events/Web API shapes used by the first-party channel. Unknown fields remain ignored. */

export interface SlackFile {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  pretty_type?: string;
  size?: number;
  mode?: string;
  is_external?: boolean;
  external_type?: string;
  file_access?: string;
  url_private?: string;
  url_private_download?: string;
}

interface SlackAppContextEntity {
  type?: string;
  value?: string;
  team_id?: string;
}

export interface SlackMessageEvent {
  type?: string;
  subtype?: string;
  hidden?: boolean;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  event_ts?: string;
  thread_ts?: string;
  channel?: string;
  channel_type?: string;
  /** `app_home_opened` only: which App Home tab was opened (`messages` signals a DM open). */
  tab?: string;
  team?: string;
  files?: SlackFile[];
  /** Included on message.im when the Agent messaging experience is enabled. */
  app_context?: { entities?: SlackAppContextEntity[] };
}

export interface SlackEventEnvelope {
  type?: string;
  challenge?: string;
  team_id?: string;
  context_team_id?: string;
  enterprise_id?: string;
  api_app_id?: string;
  event_id?: string;
  event_time?: number;
  event?: SlackMessageEvent;
  authorizations?: Array<{ team_id?: string; enterprise_id?: string; user_id?: string; is_bot?: boolean }>;
}

/** A routed Slack turn. `threadTs:null` explicitly sends at channel top level. */
export interface SlackRoute {
  session?: string;
  channelId?: string;
  threadTs?: string | null;
  text?: string;
}
