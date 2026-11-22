# @fastagent-sh/agentcore

Run a [FastAgent](https://fastagent.sh) agent on Amazon Bedrock AgentCore: one instance per AgentCore session, each in
a microVM of its own, with what it keeps in Aurora DSQL.

```bash
npm i @fastagent-sh/agentcore        # in the agent directory: adds the `agentcore` target and runtime
fastagent deploy init agentcore      # the container and the AgentCore project
npx -y @aws/agentcore@1.0.3 deploy   # here or in CI
fastagent agentcore invoke "hello" --arn <runtimeArn>   # smoke-test from the terminal
```

From a backend (`npm i @fastagent-sh/client-agentcore`):

```ts
import { connectAgentCore } from "@fastagent-sh/client-agentcore";

const agent = connectAgentCore({ runtimeArn, sessionId: sessionOf(user) });
const session = await agent.sessions.create();
const message = await agent.messages.send({ sessionId: session.id, content: "hi" }, { wait: 120 });
```

See [AgentCore](https://github.com/fastagent-sh/fastagent/blob/main/docs/agentcore.md).
