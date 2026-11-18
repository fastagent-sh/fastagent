---
title: Develop an Agent with FastAgent
description: "The agent development guide for humans and coding agents: responsibilities, TypeScript tools, local checks, scheduling and deployment."
status: current
---

# Develop an Agent with FastAgent

The path from an idea to a deployed agent, for its author and for a coding agent working for them. Each step ends
with a check you can run.

```text
decide what it does → init → prompt, skill, tool → test locally → one real message
  → schedule → deploy → report what was verified
```

## 1. Decide what goes where

Agree with the owner on the agent's goal, what it may touch, who it may contact, and what needs approval. Check for an
existing agent (a directory with `fastagent.config.ts`) and reuse it.

| What | Where |
|---|---|
| Goal, standing instructions, when to ask | `SYSTEM.md` |
| Facts about the project it works on | the project's own files, which the agent reads with its tools |
| Reusable methods | `skills/<name>/SKILL.md` |
| Exact operations and access to other systems | `src/tools/<name>.ts` |
| Timed work | `src/schedules/`, and the `wake` tool |
| Model, providers, MCP servers | `fastagent.config.ts` |
| Business records | a store you choose; a session's history is not a database |

Let the agent choose its steps; a fixed pipeline belongs in your app only when the product needs one. **A prompt or a
typed tool is not a sandbox**: the agent has a shell and its code can reach the process's files, network and
credentials. Enforce limits where the real operation happens, and isolate the whole process when you must.

## 2. Create the agent

```bash
npm install -g @fastagent-sh/fastagent
fastagent init my-agent
cd my-agent
```

The agent lives in its own directory, beside the project it works on. `init` installs dependencies (run `npm install`
if that failed) and makes the first git commit. Stay in `my-agent/` for the rest of this guide: there the global
`fastagent` runs the agent's own installed version. Without a global install, run `npx @fastagent-sh/fastagent
<command>`, never `npx fastagent`, which is another package on npm.

## 3. Set up TypeScript

Write tools, schedules, helpers and tests in TypeScript. Node ≥ 24.15 runs it directly by stripping types,
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
fail. Then restore it.

## 5. Send one real message

Pick the provider and model with the owner. `fastagent login <provider/model-id> --check` exits 0 when its provider is
ready. If not:

- **An account** (ChatGPT, a Claude subscription): `fastagent login <provider> --method account --json` returns the
  `terminal_command` the owner runs in a terminal of their own to sign in, and a `check_command` to run once they have.
- **An API key**: `fastagent login <provider> --method api-key --json` names the variable and file; the owner writes
  it there.

**Never ask for a credential in the conversation**, and keep them out of files, issues and logs.

Set `model: "provider/model-id"` in `fastagent.config.ts`, then:

```bash
fastagent invoke "Use plan-batches for 5 proposals at 2 per batch. Do not send anything."
```

This calls the model and may cost money. The answer goes to stdout and tool calls to stderr. The exit code is 0 only
when the message completed. Check the tool use and the answer, not only the exit code. `--json` prints the events, and
`--session <id>` sends a follow-up.

For ongoing work the owner runs `fastagent dev`: prompt and skill edits apply on the next message, and `src/` edits
restart it. Restart it yourself after editing `lib/`, which is not watched. Only one `dev` or `start` runs per agent.

## 6. Add a schedule

**`src/schedules/daily-review.ts`**

```ts
import { defineSchedule } from "@fastagent-sh/fastagent";

export default defineSchedule({
  cron: "0 9 * * *",
  tz: "America/New_York",
  prompt:
    "Review pending proposals and post a short digest with the post_digest tool. " +
    "Leave unapproved actions pending.",
});
```


A schedule's plain reply reaches no one, so its prompt names the tool that delivers it. Each run continues the
schedule's own session.

```bash
fastagent schedules list               # next run, last outcome, pending wake-ups
fastagent schedules run daily-review   # a real run now, through dev when it runs
```

The agent can also schedule its own follow-ups with `wake`; test one while serving. A schedule fires only while the
agent runs, so run its container without scaling it to zero.

## 7. Embed it in an app (optional)

Open the built package with `openAgent(definition, { root })` and call the [Agent API](agent-api.md): `sessions.create`,
then `messages.send` with `wait`, or `messages.stream`. `await agent.serve()` adds its schedules. The app
keeps auth, users and data. One instance is one trust domain: give users who must not see each other an instance each
([security model](agent-api.md#security)). See [Embedding](embedding.md).

## 8. Deploy

Choose the host and its cost with the owner, and read [Deploy](deploy.md) before creating anything.

```bash
fastagent docker init        # writes Dockerfile + .dockerignore, prints the docker build and run commands
```

The owner keeps the values (the model's API key, `FASTAGENT_API_KEY`) in a file of their own and
passes it to the container: never in this conversation. If `docker init` stops, fix the cause it names and run it
again ([Troubleshooting](troubleshooting.md#docker-init-stopped-or-the-container-does-not-start)). Then check the
deployment:

```bash
fastagent invoke --url <deployment URL> "hello"
```

What survives where:

| Data | Survives |
|---|---|
| Prompt, skills, code | in the image; changed only by a new release |
| Sessions, schedule runs and wake-ups | on the container's volume at `/data`, or in PostgreSQL (`FASTAGENT_DATABASE_URL`) |
| Business notes and artifacts | only in a store you choose: a release replaces the agent's own directory |

An accepted message is answered at least once across a restart, so tools with side effects must tolerate a repeat.

## 9. Report what you verified

| Check | Proves | Does not prove |
|---|---|---|
| typecheck, tests, `info --json` | types, logic, what the agent loads | model behavior |
| `invoke` | a model call and the tool path | clock, deployment |
| `schedules run` | one run of the schedule | that the clock fires it |
| `invoke --url` | the deployment answers | its clock |

Report the commands you ran and their results, the owner's remaining steps, and what was not tested. Keep secrets and
machine state out of commits, and stop servers you started.
