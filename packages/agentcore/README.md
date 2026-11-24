# @fastagent-sh/agentcore

Deploy your [FastAgent](https://github.com/fastagent-sh/fastagent) on Amazon Bedrock AgentCore with per-user microVM isolation, Amazon Aurora DSQL persistence, and AWS Secrets Manager values.

```bash
npm i @fastagent-sh/agentcore        # adds `fastagent deploy init agentcore` and `fastagent agentcore`
fastagent deploy init agentcore      # writes Dockerfile, .dockerignore, and agentcore/ CDK project
npx -y @aws/agentcore@1.0.3 deploy   # builds remotely and deploys (locally or in CI)
```

Smoke-test from your terminal (`npm i @fastagent-sh/client-agentcore` on the calling machine):

```bash
fastagent agentcore invoke "hello" --arn <runtimeArn>
```

Call from your backend with [`@fastagent-sh/client-agentcore`](https://www.npmjs.com/package/@fastagent-sh/client-agentcore):

```ts
import { connectAgentCore } from "@fastagent-sh/client-agentcore";

const agent = connectAgentCore({ runtimeArn, sessionId: sessionOf(user) });
const message = await agent.invoke({ conversation: "main", content: "hi" }, { wait: 120 });
```

See [Amazon Bedrock AgentCore](https://github.com/fastagent-sh/fastagent/blob/main/docs/agentcore.md) and [Technical architecture](https://github.com/fastagent-sh/fastagent/blob/main/docs/architecture.md).
