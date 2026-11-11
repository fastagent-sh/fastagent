/**
 * What Telegram's group privacy mode costs this channel and how to undo it, said the same way wherever it is said (the
 * serve's startup warning, `channels setup telegram`). With it on a bot in a group sees only @mentions, replies to
 * it and commands, so it cannot read the discussion a request builds on (docs/design/place-sessions.md). The flag
 * `getMe` returns is the bot's global setting: a bot made an administrator of a group receives every message of it
 * regardless, and a change reaches a group only when the bot is added to it again.
 */
export const PRIVACY_MODE_EFFECT =
  "group privacy mode is on: in a group the bot only sees @mentions, replies to it and commands, so it cannot read the " +
  "discussion a request builds on";

export const PRIVACY_MODE_FIX =
  "in @BotFather send /setprivacy, choose this bot, choose Disable; then remove the bot from each group and add it " +
  "again (Telegram applies the change to a group only when the bot joins it; a group administrator bot already " +
  "receives every message)";
