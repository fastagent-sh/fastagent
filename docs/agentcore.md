---
title: Amazon Bedrock AgentCore
description: "Deploy isolated per-user FastAgent microVMs on Amazon Bedrock AgentCore with Aurora DSQL persistence, Secrets Manager values, and zero-server client access."
status: current
---

# Amazon Bedrock AgentCore

Choose **Amazon Bedrock AgentCore** when you want automatic **per-user microVM isolation**, pay-for-active-use scale-to-zero, and managed serverless persistence with zero servers to maintain.

Each AgentCore session runs in its own microVM. FastAgent maps each session to an isolated agent instance—one per user or workspace—storing sessions, durable provider credentials, and conversation mappings in **Amazon Aurora DSQL**. When AgentCore recycles an idle microVM, the next invocation picks up right where it left off.

You use two separate packages depending on your role:
- **`@fastagent-sh/agentcore`** inside your agent repository (builds and runs the container + CDK infrastructure).
- **`@fastagent-sh/client-agentcore`** inside your backend or operator machine (zero server/DB/CDK dependencies; calls the runtime over AWS IAM).

## 1. Initialize AgentCore in your agent

```bash
npm i @fastagent-sh/agentcore
fastagent deploy init agentcore
```

This writes the files to commit:

| File | Purpose |
| --- | --- |
| `Dockerfile`, `.dockerignore` | ARM64 container running `fastagent agentcore start`, excluding `.secrets/`, `.env*`, `.state/`, and `agentcore/` |
| `agentcore/agentcore.json` | AgentCore project declaring the runtime built from `Dockerfile` |
| `agentcore/cdk/` | CDK app adding `FastAgentResources` (Aurora DSQL cluster + Secrets Manager read grant) |

`init` installs CDK dependencies (`--no-install` skips) and prints the secret names your agent expects. Once written, `agentcore/` belongs to you and is never overwritten (`--force` regenerates only FastAgent-managed container files).

## 2. Store runtime values in Secrets Manager

In each target AWS account and region, create a Secrets Manager secret named after the agent holding a JSON object of key/value strings (model API keys and any secrets declared with `needs()`):

```bash
aws secretsmanager create-secret --name support --secret-string file://values.json
```

- Each instance reads the secret on the first invocation after its microVM starts.
- If the secret does not exist yet or cannot be read, the invocation fails visibly with `internal` and retries on the next call (creating the secret after deploy requires no redeploy).
- Setting the same key in both Secrets Manager and the runtime environment is refused to avoid silent precedence conflicts.
- Amazon Bedrock models use `AWS_BEARER_TOKEN_BEDROCK` inside the secret, like any other provider key.
- To point at a different secret name, edit `secretName` in `agentcore/cdk/lib/cdk-stack.ts`.

## 3. Deploy

```bash
npx -y @aws/agentcore@1.0.3 deploy
```

The [AgentCore CLI](https://github.com/aws/agentcore-cli) builds the `linux/arm64` image remotely with CodeBuild (no local Docker or ARM64 machine required) and provisions or updates the runtime, Aurora DSQL cluster, and IAM roles.

Every CDK synthesis runs FastAgent's build-context leak check automatically and blocks deployment if `.secrets/`, `.env*`, or `.state/` would ship in the image.

### Deploying from CI

With AWS OIDC credentials configured:

```bash
npm ci
npm ci --prefix agentcore/cdk
npx -y @aws/agentcore@1.0.3 deploy --target prod
```

Pass `--skip-bootstrap` when CDK bootstrap is managed centrally.

### Custom CDK or Terraform

Import `FastAgentResources` from `@fastagent-sh/agentcore/cdk` into any CDK stack. If deploying with Terraform or CloudFormation directly:

| Setting | Requirement |
| --- | --- |
| Image | `Dockerfile` built for `linux/arm64` in ECR |
| Protocol & port | HTTP on port `8080` |
| `FASTAGENT_DSQL_ENDPOINT` | Aurora DSQL cluster endpoint |
| `FASTAGENT_SECRETS` | Secrets Manager secret name |
| Execution role | `dsql:DbConnectAdmin` on cluster, `secretsmanager:GetSecretValue` on secret, ECR pull, CloudWatch logs |

To test the container locally off AWS, pass `FASTAGENT_DATABASE_URL=postgres://...` instead of `FASTAGENT_DSQL_ENDPOINT` and supply secrets as environment variables; it listens on port `8080`.

## 4. Call and operate your deployed runtime

### From your backend (`@fastagent-sh/client-agentcore`)

```bash
npm i @fastagent-sh/client-agentcore
```

```ts
import { connectAgentCore, connectAgentCoreAuth } from "@fastagent-sh/client-agentcore";

const connection = {
  runtimeArn: "arn:aws:bedrock-agentcore:<region>:<account>:runtime/<id>",
  sessionId: sessionOf(user), // 33–256 chars: letters, digits, "-" and "_", starting alphanumeric
  qualifier: "prod",
};

const agent = connectAgentCore(connection);
const msg = await agent.invoke({ conversation: "main", content: "hi" }, { wait: 120 });

// Optional: manage provider credentials persisted in Aurora DSQL for this instance
const auth = connectAgentCoreAuth(connection);
const providers = await auth.providers();
```

`@fastagent-sh/client-agentcore` also re-exports `connectAgent`, `connectAuth`, and `AgentError`, so one backend codebase works seamlessly against local `fastagent dev` over HTTP and AgentCore in production. Your caller needs only IAM permission `bedrock-agentcore:InvokeAgentRuntime`—no `FASTAGENT_API_KEY` is used.

### From your terminal (`fastagent agentcore invoke`)

With `@fastagent-sh/client-agentcore` installed on your calling machine:

```bash
export FASTAGENT_AGENTCORE_ARN="arn:aws:bedrock-agentcore:<region>:<account>:runtime/<id>"

fastagent agentcore invoke "hello"
echo "summarize this" | fastagent agentcore invoke --json
fastagent agentcore invoke "follow up" --instance <id> --session <sessionId>
```

Supports `--arn <arn>`, `--instance <id>`, `--session <id>`, `--qualifier <name>` (default `DEFAULT`), `--model <provider/modelId>`, and `--json`.

### Via saved remotes (CLI `--remote` & `@fastagent-sh/pi-remote`)

With `@fastagent-sh/client-agentcore` installed, add an `agentcore` entry to `~/.config/fastagent/remotes.json`:

```json
{
  "remotes": {
    "bedrock": {
      "type": "agentcore",
      "runtimeArn": "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/my_agent",
      "sessionId": "ops-session-id-at-least-33-characters",
      "qualifier": "prod"
    }
  }
}
```

Then operate it just like an HTTP remote across `fastagent invoke --remote bedrock`, `fastagent login --remote bedrock`, `fastagent logout --remote bedrock`, and [`@fastagent-sh/pi-remote`](remotes.md#4-chat-interactively-from-your-terminal-fastagent-shpi-remote).

## Security, retries, and limits

- **MicroVM isolation vs. execution role:** Each `sessionId` runs in its own microVM with its own database partition. However, as AWS documents, arbitrary code running inside a microVM can access its execution role (and therefore the shared Aurora DSQL cluster and Secrets Manager secret). For strict multi-tenant user isolation, disable `bash` / arbitrary code execution (`codingTools: false`) or isolate AWS roles per tenant.
- **Retry semantics:** Transient platform issues (throttling, cold starts, microVM handoff, brief DSQL/Secrets Manager hiccups) return `AgentError("unavailable")` (`retryable: true`). Permission or configuration errors (`unauthorized`, missing secret, invalid config) are non-retryable and fail visibly.
- **Limits:** Maximum message size is **6.4 MiB** (`details.reason: "too_large"`). Files written to microVM disk do not outlive the microVM. Deleting the CDK stack retains the Aurora DSQL cluster with deletion protection enabled so session history is never dropped accidentally.
