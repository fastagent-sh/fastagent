/**
 * Telegram bot channel: verify the webhook secret token → route via `on(update)` → run the turn →
 * send the agent's reply back to the chat, ACK 200. Reply model A: the channel holds the bot token
 * and posts the reply itself (chat UX), unlike the github channel's fire-and-forget. No SDK — inbound
 * is a JSON POST, outbound is a `fetch` to the Bot API. The developer writes only `on`.
 *
 * Authored against the public `@kid7st/fastagent` surface only (the contract + the channel-authoring
 * kit: readBodyCapped / text / collect), so it is exactly what a third-party `fastagent-channel-*`
 * package would write.
 */
import { timingSafeEqual } from "node:crypto";
import type { Agent } from "../agent.ts";
import { collect } from "../collect.ts";
import { readBodyCapped } from "./body.ts";
import { text } from "./respond.ts";

/** Update body cap — Telegram updates are small JSON; 1 MiB is generous and guards a public endpoint. */
const MAX_UPDATE_BYTES = 1 << 20;

/** A Telegram message (the common subset; `[k]` keeps the rest reachable without a types dependency). */
export interface TelegramMessage {
  message_id: number;
  text?: string;
  chat: { id: number; type: string; [k: string]: unknown };
  from?: { id: number; username?: string; [k: string]: unknown };
  [k: string]: unknown;
}

/** A Telegram update (the common subset). Narrow for what you route on, e.g. `update.message?.text`. */
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  callback_query?: { id: string; data?: string; message?: TelegramMessage; [k: string]: unknown };
  [k: string]: unknown;
}

/** What `on` returns per acted-on update: a session + the prompt + the chat to reply to. */
export interface TelegramIntent {
  session: string;
  text: string;
  /** Chat the agent's reply is sent to (usually `update.message.chat.id`). */
  chatId: number | string;
}

export interface TelegramChannelOptions {
  /** Webhook secret token (the `secret_token` you set via setWebhook); verifies inbound updates. */
  secretToken: string;
  /** Bot token — used to send the agent's reply via the Bot API. */
  botToken: string;
  /** Map a verified update to the intents this agent acts on (empty array = ignore). */
  on: (update: TelegramUpdate) => TelegramIntent[];
  /** Bot API base, for tests. Defaults to the public Telegram endpoint. */
  apiBaseUrl?: string;
}

/** Constant-time compare so the secret-token check leaks no timing signal. */
function tokenMatches(header: string, secret: string): boolean {
  const a = Buffer.from(header);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function sendMessage(apiBaseUrl: string, botToken: string, chatId: number | string, body: string): Promise<void> {
  const res = await fetch(`${apiBaseUrl}/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: body }),
  });
  if (!res.ok) throw new Error(`telegram sendMessage failed: ${res.status}`);
}

/** Build a Telegram bot channel for `agent`: a Fetch handler to mount at your webhook route (POST). */
export function telegramChannel(
  agent: Agent,
  { secretToken, botToken, on, apiBaseUrl = "https://api.telegram.org" }: TelegramChannelOptions,
): (req: Request) => Promise<Response> {
  // Both are mandatory: an unset secret_token would accept forged updates (the endpoint is public);
  // the bot token is required to send the reply. Fail at construction (startup), not silently.
  if (!secretToken) {
    throw new Error(
      "telegramChannel requires a non-empty secretToken (the webhook secret_token; an unset one accepts forged updates)",
    );
  }
  if (!botToken) {
    throw new Error("telegramChannel requires a non-empty botToken (used to send the agent's reply)");
  }
  return async (req) => {
    if (req.method !== "POST") return text("POST only\n", 405);
    // Fail closed: a missing/wrong secret token is 401, never routed.
    if (!tokenMatches(req.headers.get("x-telegram-bot-api-secret-token") ?? "", secretToken)) {
      return text("invalid secret token\n", 401);
    }
    const body = await readBodyCapped(req, MAX_UPDATE_BYTES);
    if ("tooLarge" in body) return text("payload too large\n", 413);
    let update: TelegramUpdate;
    try {
      update = JSON.parse(body.text) as TelegramUpdate;
    } catch {
      return text("invalid json\n", 400);
    }

    // Run each intent and reply, ACK 200 immediately (the turn may outlast the webhook timeout). The
    // lifecycle is logged to stderr — after the 200 there is no response body, so these lines are the
    // operator's only signal (and the sink that keeps a post-ACK error from going unhandled).
    // Concurrency safety = the engine's per-session lease.
    const intents = on(update);
    for (let i = 0; i < intents.length; i++) {
      const { session, text: prompt, chatId } = intents[i] as TelegramIntent;
      const turn = `${update.update_id}#${i}`;
      console.error(`[telegram] turn start: turn=${turn} session=${session} chat=${chatId}`);
      const startedAt = Date.now();
      void collect(agent.invoke({ session }, { text: prompt })).then(
        async ({ text: reply }) => {
          if (reply.trim() !== "") await sendMessage(apiBaseUrl, botToken, chatId, reply);
          console.error(`[telegram] turn done: turn=${turn} session=${session} (${Date.now() - startedAt}ms)`);
        },
        (error) =>
          console.error(
            `[telegram] turn failed: turn=${turn} session=${session} (${Date.now() - startedAt}ms): ${String(error)}`,
          ),
      );
    }
    return new Response(null, { status: 200 });
  };
}
