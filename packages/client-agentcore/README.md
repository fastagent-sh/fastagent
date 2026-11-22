# @fastagent-sh/client-agentcore

Call a [FastAgent](https://fastagent.sh) service deployed on Amazon Bedrock AgentCore over AWS IAM—from your backend, FastAgent CLI (`--remote`), or `@fastagent-sh/pi-remote`. Zero server, database, CDK, or Node-only dependencies.

```bash
npm i @fastagent-sh/client-agentcore
```

```ts
import { connectAgentCore, connectAgentCoreAuth } from "@fastagent-sh/client-agentcore";

const connection = {
  runtimeArn: "arn:aws:bedrock-agentcore:<region>:<account>:runtime/<id>",
  sessionId: sessionOf(user), // 33–256 chars
};

const agent = connectAgentCore(connection);
const message = await agent.invoke({ content: "hi" }, { wait: 120 });
console.log(message.answer?.text);

const auth = connectAgentCoreAuth(connection);
const providers = await auth.providers();
```

Re-exports `connectAgent`, `connectAuth`, and `AgentError` from `@fastagent-sh/client` so one backend codebase works seamlessly against local `fastagent dev` over HTTP and AgentCore in production.

See [Amazon Bedrock AgentCore](https://fastagent.sh/docs/agentcore/) and [Remotes & clients](https://fastagent.sh/docs/remotes/).
