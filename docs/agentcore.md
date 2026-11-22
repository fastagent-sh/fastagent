---
title: AgentCore
description: "Run an agent on Amazon Bedrock AgentCore: an isolated instance per user, sessions in Aurora DSQL, values in Secrets Manager, deployed with the AgentCore CLI, locally or in CI."
status: current
---

# AgentCore

On [Amazon Bedrock AgentCore](https://aws.amazon.com/bedrock/agentcore/), each AgentCore session runs in a microVM of
its own, and FastAgent makes each session one instance of your agent: one per user or chat, with its own sessions,
files and commands. What an instance keeps lives in Aurora DSQL, so it survives the microVM: AgentCore stops an idle
one after its timeout, and the next request opens the instance where it left off.

## 1. Set it up

In the agent directory:

```bash
npm i @fastagent-sh/agentcore       # adds the `agentcore` target and runtime
fastagent deploy init agentcore
```

`init` writes, for you to commit:

| File | What it is |
|---|---|
| `Dockerfile`, `.dockerignore` | The agent's ARM64 image. It runs `fastagent agentcore start`, and leaves out `.secrets/`, `.env` files, state and `agentcore/` |
| `agentcore/agentcore.json` | The AgentCore project: one runtime, built from the `Dockerfile` |
| `agentcore/cdk/` | The CDK app the AgentCore CLI deploys. Its stack adds `FastAgentResources`: an Aurora DSQL cluster for the instances and read access to the agent's secret |

It installs the CDK app's dependencies (`--no-install` skips that), and prints the values the agent reads. A file of
yours is kept: `init` never writes over `agentcore/` once it exists, and `--force` regenerates only the container files
it generated. Add your own targets, runtime settings and resources to `agentcore/`: it is yours.

## 2. Give it its values

Create a Secrets Manager secret named after the agent, in each AWS account and region you deploy to: one JSON object
of the names `init` printed (the model's API key, what the agent's code declares with `needs`) to their values.

```bash
aws secretsmanager create-secret --name support --secret-string file://values.json
```

Each session reads it when its instance opens, on its first request after AgentCore starts its microVM. A secret that
cannot be read (not created yet, no access, not a JSON object of strings) refuses that request with `internal`, naming
why, and the next request reads it again: create it after the deploy and nothing needs redeploying. A changed
value reaches a session as AgentCore starts it again. A name the secret lacks refuses the instance's open, naming it. A
name both the secret and the runtime's environment set is refused too: keep it in one. To use another secret, change `secretName` in `agentcore/cdk/lib/cdk-stack.ts`.

A model on Amazon Bedrock takes a Bedrock API key (`AWS_BEARER_TOKEN_BEDROCK`) in the secret, like any provider's key.

## 3. Deploy

```bash
npx -y @aws/agentcore@1.0.3 deploy
```

The [AgentCore CLI](https://github.com/aws/agentcore-cli) builds the image remotely with CodeBuild (no local Docker or
ARM64 machine), and creates or updates the runtime, the database and the roles. Run it again for each new version. Its
other commands are yours too: `agentcore status`, `agentcore logs`, and `agentcore.json`'s targets for more accounts
or regions.

Every deploy first checks what the image would carry. One that would ship this machine's secrets or state, through a
`.dockerignore` that lets them through or no `.dockerignore` at all, stops before anything in AWS changes, naming the
files.

### In CI

The same command, with AWS credentials from your CI's identity provider (OIDC), and both projects' dependencies
installed:

```bash
npm ci
npm ci --prefix agentcore/cdk
npx -y @aws/agentcore@1.0.3 deploy --target prod
```

The runner needs neither Docker nor ARM64. An account whose CDK bootstrap someone else manages takes
`--skip-bootstrap`.

### Your own CDK or Terraform

`FastAgentResources` from `@fastagent-sh/agentcore/cdk` takes any runtime that can be granted permissions and given
environment variables. Without CDK, the runtime needs:

| Setting | Value |
|---|---|
| Image | The `Dockerfile`, built for `linux/arm64`, in ECR |
| Protocol | HTTP, port 8080 |
| `FASTAGENT_DSQL_ENDPOINT` | The Aurora DSQL cluster's endpoint |
| `FASTAGENT_SECRETS` | The secret's name |
| Execution role | `dsql:DbConnectAdmin` on the cluster, `secretsmanager:GetSecretValue` on the secret, ECR pull, logs |

To try the image off AWS, run it with `FASTAGENT_DATABASE_URL=postgres://…` in place of the cluster, and the values as
environment variables: it answers on port 8080 as it does on AgentCore.

## 4. Call it

### From the CLI

To smoke-test or script a deployed runtime from your terminal (`npm i @fastagent-sh/client-agentcore` once on the
machine calling it):

```bash
export FASTAGENT_AGENTCORE_ARN="arn:aws:bedrock-agentcore:<region>:<account>:runtime/<id>"
fastagent agentcore invoke "hello"
echo "summarize this" | fastagent agentcore invoke --json
fastagent agentcore invoke "follow up" --instance <id> --session <sessionId>
```

Each call prints the AgentCore `--instance` id and Agent API `--session` id on `stderr`, and streams the answer (or
NDJSON events with `--json`) on `stdout` with the same exit codes as `fastagent invoke`. Pass `--arn <arn>` to override
`FASTAGENT_AGENTCORE_ARN`, `--qualifier <name>` for a named endpoint, and `--model <provider/model>` to pick a model.

### From a backend

In your backend (`npm i @fastagent-sh/client-agentcore`):

```ts
import { connectAgentCore } from "@fastagent-sh/client-agentcore";

const agent = connectAgentCore({
  runtimeArn: "arn:aws:bedrock-agentcore:<region>:<account>:runtime/<id>",
  sessionId: sessionOf(user), // yours: one per user, 33 to 256 letters, digits, "-" and "_"
});
const session = await agent.sessions.create();
const message = await agent.messages.send({ sessionId: session.id, content: "hi" }, { wait: 120 });
```

`agent` is the [Agent API](agent-api.md), as `connectAgent` gives it, and `@fastagent-sh/client-agentcore` re-exports
`AgentError` and `connectAgent` so the same backend talks to `fastagent dev` locally and to AgentCore in production. It
loads no server or Node runtime: a backend needs only `@fastagent-sh/client-agentcore` and AWS credentials
that may `bedrock-agentcore:InvokeAgentRuntime` on the runtime. Each request is one invocation of the session; an answer
streams as it is written. `qualifier` picks a runtime endpoint (`prod`), and with it the version that answers.

- **The session id is the instance.** Keep the mapping from your users to session ids. Through the Agent API, a
  session id reaches only its own instance, and each runs in a microVM of its own: its files and processes are apart
  from every other's. AgentCore authenticates every request: `connectAgentCore` signs each with your AWS credentials,
  and there is no `FASTAGENT_API_KEY`.
- **The database and the secret are the agent's, not the instance's.** AWS's own guidance: "Any code or
  actor running inside the microVM can access execution role credentials." An agent that runs commands or code (`bash`,
  a tool of yours) can use the role too: it can read any instance's sessions and the secret.
  Users are kept apart from each other only from an agent whose tools run neither.
- **Retryable means it passes by itself.** A request is refused `unavailable` (retryable) only when sending it again,
  with nothing changed, can succeed: AgentCore throttling or starting the session, the instance held by the microVM
  AgentCore is replacing, the database or Secrets Manager out of reach for a moment. What needs a person is not
  retryable, and says what: `unauthorized` for credentials AWS refuses or none to sign with (sign in again, `aws
  login`), `internal` for an instance that cannot open (a secret not created or not readable, a value it lacks, no
  database configured, a runtime that does not exist).

## Limits

- A message is at most 6.4 MiB, what one DSQL transaction keeps (`too_large`).
- Files the agent writes are on the microVM's disk, and go with it.
- Deleting the stack keeps the database, with the sessions in it: delete the cluster yourself, after turning off its
  deletion protection.
