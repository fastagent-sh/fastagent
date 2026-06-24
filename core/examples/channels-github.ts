/**
 * A channel module — drop this at `channels/github.ts` in a workspace and `fastagent dev`/`start`
 * discovers it (like `tools/`). `fastagent add github` scaffolds exactly this.
 *
 * A channel = a third-party ADAPTER (githubChannel: verify + parse + ACK) wired to YOUR `on()` glue.
 * The module receives the assembled agent and returns the routes it mounts: here a GitHub webhook at
 * POST /webhook, which ACKs 202 and runs each turn fire-and-forget on the long-running process.
 * (GET /health is provided by the host — you do not declare it.)
 *
 * Real users import from "@kid7st/fastagent" and "@kid7st/fastagent/github".
 */
import { githubChannel } from "../src/github.ts";
import type { ChannelModule } from "../src/index.ts";

const channel: ChannelModule = (agent) => ({
  "POST /webhook": githubChannel(agent, {
    secret: process.env.GITHUB_WEBHOOK_SECRET ?? "",
    // Map a verified event to the intents this agent acts on (empty array = ignore). Each review is
    // INDEPENDENT and idempotent (it reconciles against the PR's existing comments), so use a
    // distinct per-delivery session: overlapping deliveries then all run on their own session (no
    // shared-session lease collision/drop) — "independent triggers → distinct sessions".
    on: (event) => {
      if (event.event === "pull_request" && event.action === "opened" && "pull_request" in event.payload) {
        const { repository, pull_request } = event.payload;
        return [
          {
            session: event.deliveryId,
            text: `Review pull request #${pull_request.number} in ${repository.full_name}.`,
          },
        ];
      }
      return [];
    },
  }),
});

export default channel;
