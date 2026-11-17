# @fastagent-sh/agentcore

Run a [FastAgent](https://fastagent.sh) agent on Amazon Bedrock AgentCore. This package holds what is AWS's: the agent's
sessions and clock in Aurora DSQL, signed in with the runtime's IAM role.

```ts
import { openAgent } from "@fastagent-sh/fastagent";
import { dsqlDatabase } from "@fastagent-sh/agentcore";
import support from "@acme/support-agent";

const agent = await openAgent(support, {
  root: "/tmp/support",
  name: "support",
  database: dsqlDatabase({ endpoint: "abcdefghij.dsql.us-east-1.on.aws" }),
});
```

See [Sessions in PostgreSQL](https://github.com/fastagent-sh/fastagent/blob/main/docs/configuration.md#sessions-in-postgresql).
