# @fastagent-sh/client

The client side of [FastAgent](https://fastagent.sh): the Agent API's types and an HTTP client for an agent that
FastAgent serves, and the contract a channel is written against.

```ts
import { connectAgent } from "@fastagent-sh/client";

const agent = connectAgent("https://agent.example.com", { apiKey: process.env.AGENT_API_KEY! });
const { id } = await agent.sessions.create();
const message = await agent.messages.send({ sessionId: id, content: "hi" }, { wait: 60 });
console.log(message.answer?.text);
```

- `@fastagent-sh/client`: the Agent API and `connectAgent`. It needs only `fetch`.
- `@fastagent-sh/client/channel`: the channel contract (`defineChannel`, `ChannelContext`).

Every other path in this package belongs to FastAgent's own packages and changes without notice.

See [the Agent API](https://github.com/fastagent-sh/fastagent/blob/main/docs/agent-api.md).
