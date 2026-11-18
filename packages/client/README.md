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

`@fastagent-sh/client` is the Agent API and `connectAgent`, and needs only `fetch`. To call an agent running on Amazon
Bedrock AgentCore, install `@aws-sdk/client-bedrock-agentcore` beside it and import `connectAgentCore` from
`@fastagent-sh/client/agentcore`. Its contract entries (`/agent-api`, `/http/contract`, `/agentcore/contract`) are the
ones FastAgent's runtime builds its servers from.

See [the Agent API](https://github.com/fastagent-sh/fastagent/blob/main/docs/agent-api.md).
