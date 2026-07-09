import { githubChannel } from "@fastagent-sh/fastagent/github";

// A channel = a third-party ADAPTER (githubChannel: verify + parse + ACK) configured with YOUR on() policy.
// fastagent discovers this file under channels/, mounts POST /webhook, and pipes the agent to the
// adapter — this file holds only policy. Set GITHUB_WEBHOOK_SECRET in .env (a missing secret fails at
// startup — an empty key would accept forged deliveries) and point a GitHub webhook (JSON) at POST /webhook.
export default githubChannel({
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
          text: `Review pull request #${pull_request.number} in ${repository.full_name}.`,
        },
      ];
    }
    return [];
  },
});
