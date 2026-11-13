---
title: Deploy
description: "Ship an agent to local Docker, Fly.io, Railway or AWS Bedrock AgentCore: one command, the values it needs, channels, logins, and what each host keeps."
status: current
---

# Deploy

```bash
fastagent deploy fly --run --env-file prod.env    # or docker, railway, agentcore
```

Without `--run`, `deploy` only writes the files (a `Dockerfile` and the host's manifest) and prints the steps. With
`--run` it does them with the host's CLI. It builds `dist/` first, so a type error stops it before anything ships.

| Host | You need | State |
|---|---|---|
| [Docker](#local-docker) | Docker Compose ≥ 2.3.3 | a volume at `/data` |
| [Fly.io](#flyio) | `flyctl` | a volume at `/data` |
| [Railway](#railway) | Railway CLI 5.x | a volume at `/data` |
| [AgentCore](#aws-bedrock-agentcore) | AWS CLI v2, Docker with buildx | `/mnt/data`, **reset on every deploy** |

## Before you deploy

1. **Try the production build here:** `fastagent build && fastagent start --root $(mktemp -d) --env-file prod.env`.
   `fastagent deploy docker --run` runs the real image on your machine.
2. **Set a model** in the configuration (`defaults.model`, or `model` in the file `--config` names). `deploy` ignores
   `FASTAGENT_MODEL` and `--model`.
3. **Give it its values.** A deployment reads no file by default: pass `--env-file <file>`, or `--from-env` to take
   them from the environment (`op run -- fastagent deploy fly --run --from-env`). `--run` stops before building when
   the target lacks a declared name, and at a terminal offers to set it. Set values any time with
   `fastagent secrets push|set <host>`.
4. **Make something reach it**: a channel, a schedule, or the [Agent API](#the-agent-api).

A coding agent deploys with `--run --json`: when prerequisites (host auth, channel credentials, target secrets) are in
place it deploys synchronously and prints the JSON outcome; if an interactive step is missing, it stops immediately naming
what the user must run in a terminal (`fly auth login`, `fastagent channels setup`, `fastagent secrets set`, or
`fastagent login --deployment`).

## Several instances

A deployment is named by the `name` in its `--config` file, else by the program. Each gets its own host resources and
its own manifest (`fly.<name>.toml`, `fastagent.<name>.compose.yml`, `agentcore.<name>.template.yaml`); the image is
shared.

```bash
fastagent deploy fly --run --config acme.json      # { "name": "acme" }
fastagent deploy fly --run --config globex.json    # { "name": "globex" }
```

`secrets`, `logs`, `destroy` and `login --deployment` take the same `--config` to pick the instance.

- The configuration is set on the host as `FASTAGENT_CONFIG_JSON`. After changing it, run `deploy <host> --force`
  (Docker, Fly, AgentCore) or `--run` again (Railway).
- Your project's own `fastagent.json` is never deployed.
- A deployed configuration cannot hold a local directory, instance `skills`/`prompts`/`instructions`, a relative MCP
  `command`, or a literal secret. Write `${NAME}` and set the value with `fastagent secrets set <host> <NAME>`.

## The Agent API

Docker, Fly and Railway serve the [Agent API](agent-api.md#over-http) under `/v1`, behind `FASTAGENT_API_KEY`. When the target
has no key, `--run` at a terminal makes one and prints it once. Without a terminal it stops and names
`fastagent secrets set <host> FASTAGENT_API_KEY --generate`. Check it:

```bash
fastagent invoke --url https://<app>.fly.dev "hello"
```

Rotate a key with `FASTAGENT_API_KEY=new,old`, move the callers, then drop `old`. `http: { api: false }` turns the API
off. AgentCore serves none.

## Chat channels

- **Webhooks point themselves.** On Fly, Railway and AgentCore the box points Telegram, Feishu and Lark at its own URL
  on every start. Slack's Request URL is yours to set: `--run` prints it, and at a terminal with `--config` records it in that file
  once Slack reaches it.
- **Use separate production apps.** Two instances on one bot split its messages. Run
  `fastagent channels setup <name> --config prod.json --env-file prod.env` for the production app. Interactive `--run`
  creates a missing Feishu/Lark production app itself.
- **Feishu/Lark receive by webhook** when deployed, unless the configuration sets
  `channels.<name>.ingress: "connection"`.
- **Docker has no public URL.** Put your own ingress in front, and set it as `http.publicUrl`, or use a channel's
  connection mode.

## Logging a deployment in

A model with no API key on the target (a ChatGPT account, say) signs in on the box itself:

```bash
fastagent login openai --deployment fly
```

The prompts show here and the browser opens here; the credential stays on the box. `deploy --run` does this once the
box is up, when the box has no credential yet; a redeploy keeps it. Without a terminal (CI), `--run` stops at that step:
use an API key for unattended deploys. A login on the box outranks a key set later; `login --deployment` again to
switch.

## Local Docker

```bash
fastagent deploy docker --run
```

Writes `Dockerfile`, `.dockerignore` and `fastagent.<name>.compose.yml`: one `agent` service on `127.0.0.1:<port>`,
a volume at `/data`, and each secret **by name only**, filled from the environment that runs Compose. `--run` checks
those names are set, builds, starts, and waits for `/health`.

```bash
docker compose -f fastagent.<name>.compose.yml logs -f agent
docker compose -f fastagent.<name>.compose.yml down      # keeps the volume; -v deletes it
```

Edit the generated files freely: a file is regenerated by `--force` only while it keeps its first marker line.

## Fly.io

```bash
fastagent deploy fly --run
```

Creates the app and its IPs, sets the values, deploys, and checks `/health` and the webhooks. It is safe to re-run.
Signs you in with `fly auth login` when needed. Idle machines suspend (`min_machines_running = 0`) unless the agent
must stay up ([scale to zero](#scale-to-zero)).

## Railway

```bash
fastagent deploy railway --run
```

Creates the project, service, volume, variables and domain, uploads, and checks `/health`. A directory linked to
another Railway project is refused unless you pass `--into-linked`.

## Scale to zero

| The agent has | Fly / Railway |
|---|---|
| a schedule | stays up: nothing would wake it on time |
| a long-connection channel | stays up |
| neither | may scale to zero |

Wake-ups do not keep a machine up: a stopped machine runs what is due when a request next wakes it. To run on a clock
and still scale to zero, have an outside cron call a channel of your own or the Agent API.

## AWS Bedrock AgentCore

```bash
fastagent deploy agentcore --run
```

Builds an arm64 image on your machine, pushes it to ECR, and deploys one CloudFormation stack: the runtime, a
forwarder Lambda with a public URL for webhooks, and EventBridge schedules for cron and wake-ups. The values live in one
Secrets Manager secret, `fastagent/<name>` (about $0.40 a month).

What to know:
- **Every deploy resets the state**, and so does 14 days idle: sessions, channel state, wake-ups and a box login. Use
  an API key, and Fly or Railway for state that must last.
- **Idle cost:** a session keeps its microVM for `--idle-timeout` seconds (default 180) after going idle.
- **Redeploys stop the running session**; in-flight work is lost.
- **No long connections, no Agent API.** Webhook bodies are capped at about 4 MiB.

```bash
fastagent logs agentcore --follow                     # the runtime (--source forwarder for the Lambda)
fastagent destroy agentcore                           # list what would be deleted
fastagent destroy agentcore --run                     # delete stack, bucket, repository, secret, logs, alarms
```

CloudWatch keeps logs forever by default: set a retention. `destroy` leaves webhook registrations on the platforms;
clear them yourself.

### The permissions a deployer needs

This policy ran every AgentCore command end to end as the only policy of an IAM user (replace `<region>` and
`<account-id>`; attach it as a customer managed policy). Its `Iam` statement can create any `fastagent-*` role, so
treat its holder as able to escalate within the account.

```json
{"Version":"2012-10-17","Statement":[
  {"Sid": "Cfn", "Effect": "Allow", "Action": ["cloudformation:CreateChangeSet", "cloudformation:DescribeChangeSet", "cloudformation:ExecuteChangeSet", "cloudformation:DeleteChangeSet", "cloudformation:DescribeStacks", "cloudformation:DescribeStackEvents", "cloudformation:DeleteStack", "cloudformation:GetTemplateSummary"], "Resource": "arn:aws:cloudformation:<region>:<account-id>:stack/fastagent-*/*"},
  {"Sid": "CfnGlobal", "Effect": "Allow", "Action": ["cloudformation:GetTemplateSummary", "cloudformation:ListStacks"], "Resource": "*"},
  {"Sid": "Iam", "Effect": "Allow", "Action": ["iam:CreateRole", "iam:DeleteRole", "iam:GetRole", "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:GetRolePolicy", "iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:PassRole", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies", "iam:TagRole", "iam:UpdateAssumeRolePolicy"], "Resource": "arn:aws:iam::<account-id>:role/fastagent-*"},
  {"Sid": "Lambda", "Effect": "Allow", "Action": ["lambda:CreateFunction", "lambda:DeleteFunction", "lambda:GetFunction", "lambda:GetFunctionConfiguration", "lambda:UpdateFunctionCode", "lambda:UpdateFunctionConfiguration", "lambda:AddPermission", "lambda:RemovePermission", "lambda:GetPolicy", "lambda:CreateFunctionUrlConfig", "lambda:DeleteFunctionUrlConfig", "lambda:GetFunctionUrlConfig", "lambda:UpdateFunctionUrlConfig", "lambda:ListTags", "lambda:TagResource"], "Resource": "arn:aws:lambda:<region>:<account-id>:function:fastagent-*"},
  {"Sid": "LambdaGlobal", "Effect": "Allow", "Action": ["lambda:GetAccountSettings"], "Resource": "*"},
  {"Sid": "AgentCore", "Effect": "Allow", "Action": ["bedrock-agentcore:CreateAgentRuntime", "bedrock-agentcore:UpdateAgentRuntime", "bedrock-agentcore:DeleteAgentRuntime", "bedrock-agentcore:GetAgentRuntime", "bedrock-agentcore:ListAgentRuntimes", "bedrock-agentcore:ListTagsForResource", "bedrock-agentcore:TagResource", "bedrock-agentcore:CreateWorkloadIdentity", "bedrock-agentcore:DeleteWorkloadIdentity", "bedrock-agentcore:GetWorkloadIdentity", "bedrock-agentcore:StopRuntimeSession", "bedrock-agentcore:InvokeAgentRuntime", "bedrock-agentcore:CreateAgentRuntimeEndpoint", "bedrock-agentcore:GetAgentRuntimeEndpoint", "bedrock-agentcore:UpdateAgentRuntimeEndpoint", "bedrock-agentcore:DeleteAgentRuntimeEndpoint", "bedrock-agentcore:ListAgentRuntimeEndpoints", "bedrock-agentcore:UntagResource", "bedrock-agentcore:PassCapacityProvider", "bedrock-agentcore:InvokeAgentRuntimeCommandShell"], "Resource": "*"},
  {"Sid": "EcrAuth", "Effect": "Allow", "Action": "ecr:GetAuthorizationToken", "Resource": "*"},
  {"Sid": "Ecr", "Effect": "Allow", "Action": ["ecr:CreateRepository", "ecr:DescribeRepositories", "ecr:DeleteRepository", "ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"], "Resource": "arn:aws:ecr:<region>:<account-id>:repository/fastagent/*"},
  {"Sid": "S3", "Effect": "Allow", "Action": ["s3:CreateBucket", "s3:PutBucketPublicAccessBlock", "s3:ListBucket", "s3:ListBucketVersions", "s3:GetBucketLocation", "s3:PutObject", "s3:GetObject", "s3:GetObjectVersion", "s3:DeleteObject", "s3:DeleteObjectVersion", "s3:DeleteBucket"], "Resource": ["arn:aws:s3:::fa-*", "arn:aws:s3:::fa-*/*"]},
  {"Sid": "Secrets", "Effect": "Allow", "Action": ["secretsmanager:CreateSecret", "secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue", "secretsmanager:DeleteSecret", "secretsmanager:TagResource"], "Resource": "arn:aws:secretsmanager:<region>:<account-id>:secret:fastagent/*"},
  {"Sid": "Logs", "Effect": "Allow", "Action": ["logs:DescribeLogGroups", "logs:DescribeLogStreams", "logs:FilterLogEvents", "logs:GetLogEvents", "logs:DeleteLogGroup", "logs:PutRetentionPolicy"], "Resource": "*"},
  {"Sid": "Scheduler", "Effect": "Allow", "Action": ["scheduler:ListSchedules", "scheduler:GetSchedule", "scheduler:DeleteSchedule"], "Resource": "*"},
  {"Sid": "SlrRead", "Effect": "Allow", "Action": "iam:GetRole", "Resource": ["arn:aws:iam::<account-id>:role/AWSServiceRoleForBedrockAgentCoreRuntimeIdentity", "arn:aws:iam::<account-id>:role/aws-service-role/runtime-identity.bedrock-agentcore.amazonaws.com/AWSServiceRoleForBedrockAgentCoreRuntimeIdentity"]},
  {"Sid": "Slr", "Effect": "Allow", "Action": "iam:CreateServiceLinkedRole", "Resource": "*", "Condition": {"StringEquals": {"iam:AWSServiceName": ["runtime-identity.bedrock-agentcore.amazonaws.com", "network.bedrock-agentcore.amazonaws.com"]}}}
]}
```

## What ships

The image holds the agent directory (at `/app`) minus `.secrets/`, `.state/`, `content/`, `node_modules`, `.env*` and
the file `--env-file` names. It installs `git` when the agent is a repository or clones GitHub content. The persistent
root holds what changes:

```text
/data/                # or /mnt/data on AgentCore
├── .state/           # sessions, channel and schedule state
├── .secrets/         # the box's own login
├── content/          # clones of github content
└── .deployment/      # lock and release record: do not delete
```

A new release replaces the image; the root stays. Run **one replica** per instance: a second process is refused.
The generated `Dockerfile` runs on any other container host too: give it a volume, the variables, and a public URL for
webhooks.
