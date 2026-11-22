# @fastagent-sh/client-agentcore

The [FastAgent](https://fastagent.sh) Agent API client for Amazon Bedrock AgentCore: `connectAgentCore`,
`connectAgentCoreAuth`, and the `remotes.json` transport plugin (`type: "agentcore"`) for FastAgent CLI and
`@fastagent-sh/pi-remote`. Zero server, database, CDK, or Node-only dependencies.

```bash
npm i @fastagent-sh/client-agentcore
```

```ts
import { connectAgent, connectAgentCore } from "@fastagent-sh/client-agentcore";

const agent = connectAgentCore({
  runtimeArn: "arn:aws:bedrock-agentcore:<region>:<account>:runtime/<id>",
  sessionId: sessionOf(user),
});
const message = await agent.invoke({ content: "hi" }, { wait: 60 });
```

See [AgentCore](https://github.com/fastagent-sh/fastagent/blob/main/docs/agentcore.md).
