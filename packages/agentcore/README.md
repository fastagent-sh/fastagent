# @fastagent-sh/agentcore

Run a compiled [FastAgent](https://github.com/fastagent-sh/fastagent) artifact inside Amazon Bedrock AgentCore MicroVMs backed by standard PostgreSQL (Aurora Serverless v2, RDS, Neon, or Supabase). Zero AWS SDK or CDK dependencies on the server.

```bash
npm install @fastagent-sh/agentcore @fastagent-sh/fastagent
```

```ts
import { serveAgentCore } from "@fastagent-sh/agentcore";
import { baseEnv } from "@fastagent-sh/fastagent";
import myAgent from "./dist/index.js";

await serveAgentCore(myAgent, {
  database: { url: process.env.FASTAGENT_DATABASE_URL! },
  secrets: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
  env: baseEnv(process.env),
});
```

Each AgentCore session maps to its own isolated MicroVM and FastAgent instance in PostgreSQL, answering `GET /ping` (`Healthy` / `HealthyBusy`) and `POST /invocations`. Pair callers with [`@fastagent-sh/client-agentcore`](../client-agentcore/README.md).
