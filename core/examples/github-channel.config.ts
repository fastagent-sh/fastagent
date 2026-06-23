/**
 * fastagent.config.ts — declaring a webhook CHANNEL instead of the default invoke channel.
 *
 * `channels` receives the assembled agent and returns this deployment's HTTP routes. Here: a GitHub
 * webhook at POST /webhook plus a health check. `fastagent start` / `fastagent dev` serve these via
 * the Node host, which keeps each turn's post-ACK `background` work alive and drains it on shutdown.
 * On a serverless host you'd mount the same handler and pin its `background` with `ctx.waitUntil`
 * (see docs/github.md). Absent a `channels` field, a deployment serves the default invoke channel
 * at POST /invoke.
 *
 * Real users import from "@kid7st/fastagent" and "@kid7st/fastagent/github".
 */
import { githubChannel } from "../src/github.ts";
import { defineConfig } from "../src/index.ts";

export default defineConfig({
  model: "openai-codex/gpt-5.5",
  channels: (agent) => {
    const webhook = githubChannel(agent, {
      // From the deploy environment; githubChannel throws at startup if unset/empty (fail visibly).
      secret: process.env.GITHUB_WEBHOOK_SECRET ?? "",
      // Route only the deliveries this agent acts on — everything else is acked (2xx) and ignored.
      on(delivery, run) {
        if (delivery.event === "pull_request" && delivery.action === "opened") {
          run({
            // Coalesce per PR (default): a new push while a review runs re-reviews the latest, ≤1 at a time.
            session: `pr-${delivery.repo}#${delivery.number}`,
            text: `Review pull request #${delivery.number} in ${delivery.repo}.`,
          });
        }
      },
    });
    return {
      "POST /webhook": webhook,
      "GET /health": () => new Response("ok"),
    };
  },
});
