# @fastagent-sh/client-agentcore

Call a [FastAgent](https://github.com/fastagent-sh/fastagent) service deployed on Amazon Bedrock AgentCore over AWS IAM—from your backend, FastAgent CLI (`--remote`), or `@fastagent-sh/pi-remote`. Zero server, database, CDK, or Node-only dependencies.

```bash
npm i @fastagent-sh/client-agentcore
```

```ts
import { connectAgentCore } from "@fastagent-sh/client-agentcore";
import { connectAgentCoreAuth } from "@fastagent-sh/client-agentcore/auth";

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

Re-exports `connectAgent` and `AgentError` from `@fastagent-sh/client` (and `connectAuth` from `@fastagent-sh/client-agentcore/auth`) so one backend codebase works seamlessly against local `fastagent dev` over HTTP and AgentCore in production.

See [Amazon Bedrock AgentCore](https://github.com/fastagent-sh/fastagent/blob/main/docs/agentcore.md) and [Remotes & clients](https://github.com/fastagent-sh/fastagent/blob/main/docs/remotes.md).
