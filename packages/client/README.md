# @fastagent-sh/client

Call any HTTP [FastAgent](https://github.com/fastagent-sh/fastagent) service—or manage its remote model-provider logins—from Node, Bun, Deno, or edge workers. Zero Node dependencies; needs only `fetch`.

```bash
npm i @fastagent-sh/client
```

```ts
import { connectAgent, connectAuth } from "@fastagent-sh/client";

const agent = connectAgent("https://agent.example.com", {
  apiKey: process.env.AGENT_API_KEY!,
});

// Single-call idempotent invoke with a caller-named conversation
const reply = await agent.invoke(
  {
    conversation: "incident:inc-415",
    idempotencyKey: webhookEventId,
    content: "Triage the 503 spike on /api/checkout",
  },
  { wait: 120 },
);
console.log(reply.status, reply.answer?.text);

// Or inspect / manage model-provider auth on the deployed instance
const auth = connectAuth("https://agent.example.com", {
  apiKey: process.env.AGENT_API_KEY!,
});
const providers = await auth.providers();
```

Also exports the Agent API schemas (`/agent-api`), HTTP contract (`/http/contract`), and pluggable `remotes.json` transport contract (`/remotes`) used by cloud transport clients like `@fastagent-sh/client-agentcore`.

See [Agent API](https://github.com/fastagent-sh/fastagent/blob/main/docs/agent-api.md) and [Remotes & clients](https://github.com/fastagent-sh/fastagent/blob/main/docs/remotes.md).
