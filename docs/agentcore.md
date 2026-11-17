---
title: AgentCore
description: "Run an agent on Amazon Bedrock AgentCore: one isolated instance per user, sessions in Aurora DSQL, and the Agent API through each session's endpoint."
status: current
---

# AgentCore

On [Amazon Bedrock AgentCore](https://aws.amazon.com/bedrock/agentcore/), each AgentCore session runs in a microVM of
its own, and FastAgent makes each session one instance of your agent: one per user or chat, with its own sessions,
files and commands. What an instance keeps lives in Aurora DSQL, so it survives the microVM: AgentCore stops an idle
one after its timeout, and the next request opens the instance where it left off.

```bash
npm i @fastagent-sh/agentcore       # in the agent directory, beside @fastagent-sh/fastagent
```

## 1. The image

AgentCore runs an ARM64 container that serves port 8080. `fastagent-agentcore` is its command: it serves the build in
`/app/dist`.

```dockerfile
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN ./node_modules/.bin/fastagent build
CMD ["./node_modules/.bin/fastagent-agentcore", "/app"]
```

```bash
docker build --platform linux/arm64 -t <account>.dkr.ecr.<region>.amazonaws.com/my-agent:1 .
docker push <account>.dkr.ecr.<region>.amazonaws.com/my-agent:1
```

## 2. The database and the runtime

1. Create an Aurora DSQL cluster for the agent, in the runtime's region. Every instance of the agent is kept there,
   under its session id.
2. Create the AgentCore runtime from the image, with:
   - the HTTP protocol and `allowedPorts: [{ port: 8080 }]`, which gives each session the endpoint the Agent API is
     reached through;
   - the environment variable `FASTAGENT_DSQL_ENDPOINT=<cluster id>.dsql.<region>.on.aws`, and the agent's values (the
     model's API key, what its tools declare with `needs`), as `fastagent start` takes them;
   - an execution role that may pull the image, write logs, and `dsql:DbConnectAdmin` on the cluster.

## 3. Call it

```ts
import { connectAgentCore } from "@fastagent-sh/agentcore/client";

const agent = connectAgentCore({
  runtimeArn: "arn:aws:bedrock-agentcore:<region>:<account>:runtime/<id>",
  sessionId: sessionOf(user), // yours: one per user, 33 to 256 letters, digits, "-" and "_"
});
const session = await agent.sessions.create();
const message = await agent.messages.send({ sessionId: session.id, content: "hi" }, { wait: 120 });
```

`agent` is the [Agent API](agent-api.md), as `connectAgent` gives it. `@fastagent-sh/agentcore/client` loads no
runtime: a backend needs only it and AWS credentials that may `bedrock-agentcore:InvokeAgentRuntime` and
`bedrock-agentcore:InvokeAgentRuntimeProxy` on the runtime.

- **The session id is the instance.** Keep the mapping from your users to session ids, and give a user who must not
  see another's work a session id of their own. AgentCore authenticates every request: `connectAgentCore` signs each
  with your AWS credentials, and there is no `FASTAGENT_API_KEY`.
- **AgentCore's refusals are the Agent API's:** a request AgentCore refuses before it reaches the agent rejects with an
  `AgentError`, `unauthorized` for `AccessDenied` and `unavailable` (retryable) for throttling.

## Limits

- Schedules and wake-ups fire only while the session's microVM runs: AgentCore stops an idle one, and nothing wakes it
  yet.
- A message is at most 6.4 MiB, what one DSQL transaction keeps (`too_large`).
- Files the agent writes are on the microVM's disk, and go with it.
