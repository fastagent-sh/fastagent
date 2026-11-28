# Per-User MicroVM Agent on Amazon Bedrock AgentCore

Deploy one agent and serve every end user inside an isolated Amazon Bedrock AgentCore microVM backed by **Amazon Aurora DSQL** and **AWS Secrets Manager**:

- **Zero servers to maintain:** AgentCore recycles idle microVMs automatically; Aurora DSQL preserves every session, conversation mapping, and remote OAuth credential across cold starts.
- **Zero-server backend client:** `backend-caller.ts` uses `@fastagent-sh/client-agentcore` (`connectAgentCore`) and `@fastagent-sh/client-agentcore/auth` (`connectAgentCoreAuth`) over AWS IAM—no `FASTAGENT_API_KEY` required.
- **Live remote control from your terminal:** Add the runtime to `~/.config/fastagent/remotes.json` (see [`remotes.example.json`](./remotes.example.json)) to operate any user's instance with `fastagent invoke --remote`, `fastagent login --remote`, or `@fastagent-sh/pi-remote` (`/fa`).

## 1. Initialize & deploy to AWS

```bash
npm install
npx @fastagent-sh/fastagent deploy init agentcore
```

Create the Secrets Manager secret holding your provider key (JSON object, e.g. `{"ANTHROPIC_API_KEY":"..."}` or `{"AWS_BEARER_TOKEN_BEDROCK":"..."}`):

```bash
aws secretsmanager create-secret --name fastagent-agentcore-per-user --secret-string file://values.json
npx -y @aws/agentcore@1.0.3 deploy
```

## 2. Call from your backend or CLI

```bash
export FASTAGENT_AGENTCORE_ARN="arn:aws:bedrock-agentcore:<region>:<account>:runtime/<id>"

# Smoke-test directly from the CLI
npx @fastagent-sh/fastagent agentcore invoke "Draft a 2-bullet kickoff brief"

# Or call via @fastagent-sh/client-agentcore
USER_ID=alice node backend-caller.ts
```

## 3. Connect interactively with `@fastagent-sh/pi-remote`

Copy [`remotes.example.json`](./remotes.example.json) into `~/.config/fastagent/remotes.json` (updating `runtimeArn` and `sessionId`), then connect from Pi:

```bash
pi -e npm:@fastagent-sh/pi-remote --fa bedrock-dev
```
