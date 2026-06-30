/**
 * Scaffold template content (data, not logic): the files `init` and `add` write into a workspace.
 * Kept apart from the scaffold mechanics (init.ts / add-channel.ts) so a template tweak and a logic
 * change never collide in one file. Templates are TS string literals, so nested code escapes its
 * backticks/backslashes (e.g. `\\s+`, the send-tool's string concatenation) — the cost of inlining.
 */
import { basename, resolve } from "node:path";

/** Identity persona (clean — it is the system prompt). The complete variant references the tool. */
export function agentsMd(minimal: boolean): string {
  const toolLine = minimal ? "" : "\nWhen the user asks how long a piece of text is, use the word-count tool.\n";
  return `# Assistant

You are a concise, helpful assistant. Answer directly and skip filler.

When the user asks you to write or edit prose, consult the house-style skill first.
${toolLine}`;
}

export const SKILL_MD = `---
name: house-style
description: The house writing style. Consult before writing or editing any prose for the user.
---
# House style

- Prefer short sentences and the active voice.
- Avoid marketing adjectives ("seamless", "powerful", "robust").
- Lead with the answer; put caveats after.
`;

export const TOOL_TS = `import { defineTool, z } from "@kid7st/fastagent";

// A code tool: filename (word-count.ts) is the tool name. tools/ is auto-discovered,
// so it needs no registration in fastagent.config. Test it directly with:
//   fastagent tool word-count '{"text":"hello there world"}'
export default defineTool({
  description: "Count the words and characters in a piece of text.",
  input: z.object({ text: z.string().describe("The text to measure") }),
  async execute({ text }) {
    const trimmed = text.trim();
    return { words: trimmed ? trimmed.split(/\\s+/).length : 0, characters: text.length };
  },
});
`;

export const CONFIG_MJS = `// fastagent.config.mjs — deployment choices only (model / http; code tools auto-discover from tools/).
// Your agent's identity and behavior live in AGENTS.md + skills/ + tools/, never here.
// Model precedence: \`--model\` flag > FASTAGENT_MODEL env > this default.
// Change "model" to a "provider/modelId" you have access to (\`fastagent models\` lists them).
export default {
  model: "openai-codex/gpt-5.5",
  http: { port: 8787 },
};
`;

export const GITIGNORE = `# secrets — never commit (kept out of git and any deploy copy)
.env

# dependencies (reinstalled at deploy)
node_modules/

# fastagent machine state (dev/start sessions)
.fastagent/
`;

// All-commented: copying to .env sets nothing by accident, and every knob is optional. Auth leads
// with `fastagent login` because the default model (openai-codex) is OAuth-only — never imply an API key.
export const ENV_EXAMPLE = `# Environment for this agent. Copy to .env (gitignored) and uncomment what you need.
# Everything here is OPTIONAL — the defaults work without a .env.

# --- Model auth ---
# The default model (openai-codex) signs in with OAuth, not an API key: run \`fastagent login\` once.
# Switch to an API-key provider? Set its key here — the variable name is provider-specific
# (e.g. OPENAI_API_KEY, ANTHROPIC_API_KEY). Run \`fastagent models\` to see available specs.
# OPENAI_API_KEY=
# ANTHROPIC_API_KEY=

# --- Model selection (overrides fastagent.config) ---
# Precedence: --model flag > FASTAGENT_MODEL > config.
# FASTAGENT_MODEL=openai-codex/gpt-5.5

# --- Serving (fastagent start) ---
# Port precedence: --port > PORT > config.http.port > 8787
# PORT=8787
# Where conversations persist (default: ./fastagent-sessions)
# FASTAGENT_SESSIONS_DIR=./fastagent-sessions
`;

/** package.json for the complete agent: ESM + the deps a defineTool tool imports. The
 *  @kid7st/fastagent range tracks THIS build's version, so a fresh workspace installs an API-matching version. */
export function packageJson(name: string, version: string): string {
  return `${JSON.stringify(
    {
      name,
      private: true,
      type: "module",
      dependencies: { "@kid7st/fastagent": `^${version}`, zod: "^4.0.0" },
    },
    null,
    2,
  )}\n`;
}

/** Sanitize a directory basename into a valid npm package name (lowercase, safe chars). */
export function toPackageName(dir: string): string {
  const base = basename(resolve(dir))
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/^[._-]+/, "");
  return base || "agent";
}

/** A scaffolded `channels/github.ts`: the third-party adapter import + a starter `on()` to edit. */
export const CHANNEL_GITHUB_TS = `import { githubChannel } from "@kid7st/fastagent/github";
import type { ChannelModule } from "@kid7st/fastagent";

// A channel = a third-party ADAPTER (githubChannel: verify + parse + ACK) wired to YOUR on() glue.
// fastagent discovers this file under channels/ and serves the routes it returns. Set
// GITHUB_WEBHOOK_SECRET in .env (a missing secret fails at startup — an empty key would accept forged
// deliveries) and point a GitHub webhook (JSON) at POST /webhook.
const channel: ChannelModule = (agent) => ({
  "POST /webhook": githubChannel(agent, {
    secret: process.env.GITHUB_WEBHOOK_SECRET ?? "",
    // Map a verified event to the intents the agent acts on (empty array = ignore). Each review is
    // INDEPENDENT and idempotent (it reconciles against the PR's existing comments), so use a
    // distinct per-delivery session (event.deliveryId): overlapping deliveries then run on their
    // own session without a shared-lease drop.
    on: (event) => {
      if (event.event === "pull_request" && event.action === "opened" && "pull_request" in event.payload) {
        const { repository, pull_request } = event.payload;
        return [
          {
            session: event.deliveryId,
            text: \`Review pull request #\${pull_request.number} in \${repository.full_name}.\`,
          },
        ];
      }
      return [];
    },
  }),
});

export default channel;
`;

/** A scaffolded `channels/telegram.ts`: the Telegram adapter import + an optional `route()` to edit. */
export const CHANNEL_TELEGRAM_TS = `import { telegramChannel } from "@kid7st/fastagent/telegram";
import type { ChannelModule } from "@kid7st/fastagent";

// A channel = a third-party ADAPTER (telegramChannel: verify + run + reply) wired to YOUR policy.
// fastagent discovers this file under channels/ and serves the routes it returns. Setup:
//   1. @BotFather → /newbot → put the bot token in TELEGRAM_BOT_TOKEN
//   2. pick a random TELEGRAM_SECRET_TOKEN (verifies that inbound updates really come from Telegram)
//   3. register the webhook once, pointing Telegram at POST /telegram with that secret:
//        curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \\
//          -d url=https://your.host/telegram -d secret_token=$TELEGRAM_SECRET_TOKEN
const channel: ChannelModule = (agent) => ({
  "POST /telegram": telegramChannel(agent, {
    secretToken: process.env.TELEGRAM_SECRET_TOKEN ?? "", // missing → fails at startup (would accept forged updates)
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",       // used to send the agent's reply back to the chat
    // Dev/personal bot: surface raw errors to the chat so you (and your AI agent) can act on them. The
    // chat is customer-facing by default — for a public bot, drop this or return a neutral string;
    // full details always go to the server log regardless.
    onError: (failed) => \`⚠️ \${failed.details}\`,
    // The channel owns transport + format (HTML) + attachments (photo→vision, file→disk) + streaming.
    // \`route\` (POLICY) is OPTIONAL — omitted, it uses defaultTelegramRoute: private chats always answer,
    // groups only on a command / reply to the bot / @mention. Override to customise, reusing the export:
    //   route: (u) => defaultTelegramRoute(u) && { session: \`user:\${u.message?.from?.id}\` },
    //   route: (u) => defaultTelegramRoute(u) && { text: \`\${telegramEnvelope(u.message!)}\\n[extra]\` },
  }),
});

export default channel;
`;

/** A scaffolded `tools/telegram-send.ts`: the outbound action — the agent uploads a local file to a chat. */
export const TELEGRAM_SEND_TOOL_TS = `import { defineTool, z } from "@kid7st/fastagent";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

// Send a local file back to a Telegram chat. The agent passes a chatId it reads from the
// [telegram: chat …] context line the channel injects. tools/ is auto-discovered — no registration.
export default defineTool({
  description:
    "Send a local file to a Telegram chat (a document, or a photo if it is an image). Pass the chatId from the [telegram: chat …] context line.",
  input: z.object({
    chatId: z.union([z.string(), z.number()]).describe("target chat id (from the [telegram: chat …] context line)"),
    path: z.string().describe("absolute path of the local file to send"),
    caption: z.string().optional(),
    asPhoto: z.boolean().optional().describe("send as a photo (inline) instead of a document"),
    messageThreadId: z.number().optional().describe("thread to reply into (from the context line), if any"),
  }),
  async execute({ chatId, path, caption, asPhoto, messageThreadId }) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
    const method = asPhoto ? "sendPhoto" : "sendDocument";
    const form = new FormData();
    form.set("chat_id", String(chatId));
    if (messageThreadId !== undefined) form.set("message_thread_id", String(messageThreadId));
    if (caption) form.set("caption", caption);
    form.set(asPhoto ? "photo" : "document", new Blob([await readFile(path)]), basename(path));
    const res = await fetch("https://api.telegram.org/bot" + token + "/" + method, { method: "POST", body: form });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    if (!res.ok || !data.ok) throw new Error("telegram " + method + " failed: " + res.status + " " + (data.description ?? ""));
    return "sent " + basename(path) + " to chat " + chatId;
  },
});
`;
