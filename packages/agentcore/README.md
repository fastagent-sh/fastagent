# @fastagent-sh/agentcore

Run a [FastAgent](https://fastagent.sh) agent on Amazon Bedrock AgentCore: one instance per AgentCore session, each in
a microVM of its own, with what it keeps in Aurora DSQL.

In the container, `fastagent-agentcore /app` serves the agent's build, with its instances in the cluster
`FASTAGENT_DSQL_ENDPOINT` names. From a backend:

```ts
import { connectAgentCore } from "@fastagent-sh/agentcore/client";

const agent = connectAgentCore({ runtimeArn, sessionId: sessionOf(user) });
const session = await agent.sessions.create();
const message = await agent.messages.send({ sessionId: session.id, content: "hi" }, { wait: 120 });
```

See [AgentCore](https://github.com/fastagent-sh/fastagent/blob/main/docs/agentcore.md).
