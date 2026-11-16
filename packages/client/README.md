# @fastagent-sh/client

The client of [FastAgent](https://fastagent.sh): the Agent API's types and an HTTP client for an agent that FastAgent
serves.

```ts
import { connectAgent } from "@fastagent-sh/client";

const agent = connectAgent("https://agent.example.com", { apiKey: process.env.AGENT_API_KEY! });
const { id } = await agent.sessions.create();
const message = await agent.messages.send({ sessionId: id, content: "hi" }, { wait: 60 });
console.log(message.answer?.text);
```

`@fastagent-sh/client` is the Agent API and `connectAgent`, and needs only `fetch`. Its other two entries,
`/agent-api` (the API's schemas) and `/http/contract` (the API over HTTP), are the ones FastAgent's runtime builds its server from.

See [the Agent API](https://github.com/fastagent-sh/fastagent/blob/main/docs/agent-api.md).
