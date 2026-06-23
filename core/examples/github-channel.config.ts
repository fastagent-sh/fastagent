/**
 * fastagent.config.ts — declaring a webhook CHANNEL instead of the default invoke channel.
 *
 * `channels` receives the assembled agent and returns this deployment's HTTP routes. Here: a GitHub
 * webhook at POST /webhook plus a health check. `fastagent start` / `fastagent dev` serve them. The
 * webhook ACKs 202 immediately and runs each turn fire-and-forget on the long-running process.
 * Absent a `channels` field, a deployment serves the default invoke channel at POST /invoke.
 *
 * Real users import from "@kid7st/fastagent" and "@kid7st/fastagent/github".
 */
import { githubChannel } from "../src/github.ts";
import { defineConfig } from "../src/index.ts";

export default defineConfig({
  model: "openai-codex/gpt-5.5",
  channels: (agent) => ({
    "POST /webhook": githubChannel(agent, {
      secret: process.env.GITHUB_WEBHOOK_SECRET ?? "",
      // Map a verified event to the intents this agent acts on (empty array = ignore).
      on: (event) =>
        event.event === "pull_request" && event.action === "opened"
          ? [{ session: `pr-${event.deliveryId}`, text: "Review the pull request in this event." }]
          : [],
    }),
    "GET /health": () => new Response("ok"),
  }),
});
