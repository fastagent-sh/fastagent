# @fastagent-sh/client-agentcore

Call a [FastAgent](https://github.com/fastagent-sh/fastagent) service deployed on Amazon Bedrock AgentCore over AWS IAM. Zero server, database, or Node-only dependencies; runs anywhere `fetch` and the AWS SDK run.

```bash
npm install @fastagent-sh/client-agentcore
```

```ts
import { connectAgentCore } from "@fastagent-sh/client-agentcore";
import { connectAgentCoreAuth } from "@fastagent-sh/client-agentcore/auth";

const connection = {
  runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/my_agent",
  sessionId: "user-42-session-id-at-least-33-characters",
};

const agent = connectAgentCore(connection);
const reply = await agent.invoke({ content: "Summarize my latest alerts" }, { wait: 120 });

const auth = connectAgentCoreAuth(connection);
const providers = await auth.providers();
```
