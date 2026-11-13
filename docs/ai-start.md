---
title: Develop an Agent with FastAgent
description: "The agent development guide for humans and coding agents: responsibilities, TypeScript tools, local checks, native channels, scheduling and deployment."
status: current
---

# Develop an Agent with FastAgent

The path from an idea to a deployed agent, for its author and for a coding agent working for them. Each step ends
with a check you can run.

```text
decide what it does → init → prompt, skill, tool → test locally → one real message
  → channel → schedule → deploy → report what was verified
```

## 1. Decide what goes where

Agree with the owner on the agent's goal, what it may touch, who it may contact, and what needs approval. Check for an
existing agent (a directory with `fastagent.config.ts`) and reuse it.

| What | Where |
|---|---|
| Goal, standing instructions, when to ask | `SYSTEM.md` |
| Facts about the project it works on | the project's own files, declared as [content](configuration.md#content) |
| Reusable methods | `skills/<name>/SKILL.md` |
| Exact operations and access to other systems | `src/tools/<name>.ts` |
| Chat and webhooks | `src/channels/` (use a built-in channel) |
| Timed work | `src/schedules/`, and the `wake` tool |
| Model and defaults | `fastagent.config.ts` |
| Business records | a store you choose; a session's history is not a database |

Let the agent choose its steps; a fixed pipeline belongs in your app only when the product needs one. **A prompt or a
typed tool is not a sandbox**: the agent has a shell and its code can reach the process's files, network and
credentials. Enforce limits where the real operation happens, and isolate the whole process when you must.

## 2. Create the agent

```bash
npm install -g @fastagent-sh/fastagent
fastagent init my-agent                       # or: fastagent init my-agent --content ~/code/app
cd my-agent
```

The agent lives in its own directory, beside the project it works on. `init` installs dependencies (run `npm install`
if that failed) and makes the first git commit. Stay in `my-agent/` for the rest of this guide.

## 3. Set up TypeScript

Write tools, channels, schedules, helpers and tests in TypeScript. Node ≥ 24.15 runs it directly by stripping types,
so:
- import relative files with `.ts` extensions (`../lib/batches.ts`), and types with `import type`;
- avoid enums, namespaces, parameter properties, decorators and JSX.

```bash
npm install --save-dev typescript@^7.0.2 @types/node@22
npm pkg set 'scripts.typecheck=tsc --noEmit' 'scripts.test=node --test test/*.test.ts'
mkdir -p lib test skills/review-batches src/tools src/schedules
```

**`tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "lib/**/*.ts", "test/**/*.ts", "fastagent.config.ts"]
}
```


## 4. Add a prompt, a skill and a tool

An offline example: an agent that plans review batches.

**`SYSTEM.md`**

```markdown
# Review assistant

Help the owner review project proposals in manageable batches. Choose relevant sources and methods,
separate evidence from assumptions, and retain the owner's decisions in the agreed working notes.
Use review-batches when planning a review and plan-batches for the batch count.
Ask before sending messages, publishing changes, or spending money. Record pending approvals instead
of treating silence as permission.
```


**`skills/review-batches/SKILL.md`**

```markdown
---
name: review-batches
description: Plan manageable batches when the owner asks to review a set of proposals.
---

Confirm which proposals are in scope and the owner's preferred batch size. Use plan-batches for the
count. Group related proposals, explain uncertain evidence, and present a draft plan for approval.
```


**`lib/batches.ts`**

```ts
export function batchCount(items: number, size: number): number {
  return Math.ceil(items / size);
}
```


**`src/tools/plan-batches.ts`**

```ts
import { int, obj } from "@earendil-works/pi-schema";
import { defineTool } from "@earendil-works/pi-durable";
import { batchCount } from "../../lib/batches.ts";

export default defineTool({
  name: "plan-batches",
  description: "Count review batches for a non-negative item count and a positive batch size.",
  parameters: obj({
    items: int({ minimum: 0 }),
    size: int({ minimum: 1 }),
  }),
  execute: async ({ items, size }) => ({
    output: [{ type: "text", text: JSON.stringify({ batches: batchCount(items, size) }) }],
  }),
});
```


`parameters` is checked before `execute` runs; TypeScript types alone do not check incoming JSON. A tool that needs a
secret wraps itself in `needs(["NAME"], (secrets) => defineTool(…))`. Helpers live outside `src/` (here `lib/`).

**`test/batches.test.ts`**

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { batchCount } from "../lib/batches.ts";
import planBatches from "../src/tools/plan-batches.ts";

test("batch planning calculates counts, and the tool answers with them", async () => {
  assert.equal(batchCount(5, 2), 3);
  // This tool uses neither the harness's api nor its context.
  const result = await planBatches.execute({ items: 5, size: 2 }, {} as never, {} as never);
  assert.deepEqual(result.output, [{ type: "text", text: '{"batches":3}' }]);
});
```


Check it, with no model and no credentials:

```bash
npm run typecheck
npm test
fastagent info --json      # lists the plan-batches tool and /skill:review-batches
```

To prove type checking is on, change `batchCount(5, 2)` to `batchCount("5", 2)` in the test: `npm run typecheck` must
fail. Then restore it. Reuse a published skill with `fastagent add skill <owner/repo/path>`, after reading it.

## 5. Send one real message

Pick the provider and model with the owner. `fastagent auth check --provider <id>` exits 0 when it is ready. If not:

- **An account** (ChatGPT, a Claude subscription): `fastagent login <provider> --method account --json` returns a
  `url` for the owner and a `check_command` to run once they have signed in.
- **An API key**: `fastagent login <provider> --method api-key --json` names the variable and file; the owner writes
  it there.

**Never ask for a credential in the conversation**, and keep them out of files, issues and logs.

Set `defaults: { model: "provider/model-id" }` in `fastagent.config.ts`, then:

```bash
fastagent invoke "Use plan-batches for 5 proposals at 2 per batch. Do not send anything."
```

This calls the model and may cost money. The answer goes to stdout and tool calls to stderr. The exit code is 0 only
when the message completed. Check the tool use and the answer, not only the exit code. `--json` prints the events, and
`--session <id>` sends a follow-up.

For ongoing work the owner runs `fastagent dev`: prompt and skill edits apply on the next message, and `src/` edits
restart it. Restart it yourself after editing `lib/`, which is not watched. Only one `dev` or `start` runs per agent.

## 6. Add a channel

| Channel | Run | The owner |
|---|---|---|
| Telegram | `fastagent add telegram && fastagent channels setup telegram --json` | creates the bot with @BotFather and saves `TELEGRAM_BOT_TOKEN` to `.secrets/.env` (or runs `fastagent channels setup telegram` in a terminal) |
| Slack | `fastagent add slack && fastagent channels setup slack --json` | creates the app from the link, installs it, and saves its tokens to `.secrets/.env` (or runs `fastagent channels setup slack` in a terminal) |
| Feishu | `fastagent add feishu && fastagent channels setup feishu --json` | runs `fastagent channels setup feishu` in a terminal (or adds `FEISHU_APP_ID` / `FEISHU_APP_SECRET`), then publishes in the console |
| Lark | `fastagent add lark && fastagent channels setup lark --json` | creates the app from the link and saves its App ID and Secret to `.secrets/.env` (or runs `fastagent channels setup lark` in a terminal) |

With `--json`, `channels setup` validates `.secrets/.env` (or `--env-file`) statelessly: when credentials are missing or
refused it exits 2 with `need_user_action` (env var names, guide URL, and `rerun` command); once written, re-running
`--json` verifies them and exits 0. Then run `fastagent dev --no-input` (no tunnel needed) and have the owner send a
real message. A passed URL check is not a conversation.

Chat replies are sent for you. Use a send tool (`telegram_send`, `slack_send`, …) only to reach someone outside the
current turn, with an approved recipient.

## 7. Add a schedule

**`src/schedules/daily-review.ts`**

```ts
import { defineSchedule } from "@fastagent-sh/fastagent";

export default defineSchedule({
  cron: "0 9 * * *",
  tz: "America/New_York",
  prompt:
    "Review pending proposals and use telegram_send to send a short digest to Telegram chat 123456789. " +
    "Leave unapproved actions pending.",
});
```


A schedule has no chat to reply in, so its prompt names the send tool and the recipient. Each run continues the
schedule's own session.

```bash
fastagent schedules list           # next run, last outcome
fastagent schedules run daily-review   # a real run now (refused while dev serves)
```

The agent can also schedule its own follow-ups with `wake`; test one while serving. On Fly and Railway a schedule
keeps the machine up; on AgentCore, EventBridge runs it ([Deploy](deploy.md#scale-to-zero)).

## 8. Embed it in an app (optional)

Open the built package with `openAgent(definition, { root })` and call the [Agent API](agent-api.md): `sessions.create`,
then `messages.send` with `wait`, or `messages.stream`. `await agent.serve()` adds its channels and schedules. The app
keeps auth, users and data. One instance is one trust domain: give users who must not see each other an instance each
([security model](agent-api.md#security)). See [Embedding](embedding.md).

## 9. Deploy

Choose the host and its cost with the owner, and read its section in [Deploy](deploy.md) before creating anything.

```bash
fastagent secrets list fly                          # which values the target still lacks
fastagent secrets push fly --env-file prod.env      # set the declared ones from a file
fastagent deploy fly --run --json                   # returns a ticket
fastagent deploy fly --check <ticket>               # working → need_user_action … → done, with the URL
```

The owner types any missing value with `fastagent secrets set <host> <NAME>`. Relay each `need_user_action` (host
sign-in, Feishu app, the box's model login). A `failed` ticket carries `log_tail`: fix the cause and deploy again
([Troubleshooting](troubleshooting.md#a-deploy-stopped-and-the-message-does-not-say-why)). Then check the deployment:

```bash
fastagent invoke --url <deployment URL> "hello"
```

What survives where:

| Data | Survives |
|---|---|
| Prompt, skills, code | in the image; changed only by a new release |
| Sessions, channel and schedule state, the box's login | on the host's volume (Docker, Fly, Railway); AgentCore resets it on every deploy |
| Business notes and artifacts | only in a store you choose: a release replaces the agent's own directory |

Channels replay an accepted turn at least once, so tools with side effects must tolerate a repeat.

## 10. Report what you verified

| Check | Proves | Does not prove |
|---|---|---|
| typecheck, tests, `info --json` | types, logic, what the agent loads | model or channel behavior |
| `invoke` | a model call and the tool path | channels, clock, deployment |
| `schedules run` | one run of the schedule | that the clock fires it |
| a real chat message | the channel end to end | proactive delivery |
| `invoke --url` | the deployment answers | its channels and clock |

Report the commands you ran and their results, the owner's remaining steps, and what was not tested. Keep secrets and
machine state out of commits, and stop servers you started.
