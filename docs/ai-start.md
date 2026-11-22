---
title: Develop an Agent with FastAgent
description: "Step-by-step guide to take an agent from idea to tested, deployed durable service—for human authors and coding agents."
status: current
---

# Develop an Agent with FastAgent

Take an agent from an idea to a tested, deployed durable service. Every step ends with a concrete check you can run. This guide works equally well for a human developer and for a coding agent building on the owner's behalf.

```text
define scope → init → prompt, skill, tool → typecheck & unit test → live invoke
  → deploy check & deploy → verify & report
```

## 1. Decide what goes where

Confirm the agent's goal, allowed actions, external contacts, and approval rules with the owner. If an agent directory already exists (contains `fastagent.config.ts`), reuse it.

| Responsibility | Where it belongs |
| --- | --- |
| Goal, standing rules, approval boundaries | `SYSTEM.md` |
| Project facts the agent works on | The project's own files, read via tools |
| Reusable procedures | `skills/<name>/SKILL.md` |
| Exact, typed operations and external API calls | `src/tools/<name>.ts` |
| Model, harness, sandbox, coding tools, providers, MCP servers | `fastagent.config.ts` |
| Application records & user data | Your own database; session history is not a business database |

Let the agent decide its own steps; keep rigid multi-step pipelines in your app only when the product requires fixed orchestration.

**Choose the right isolation posture:** on the default `pi-durable` harness, built-in coding tools (`read`, `write`, `edit`, `bash`) run with the OS process's permissions—a prompt or typed tool is not a sandbox. When you need confinement, either set `codingTools: false` (or `["read"]`) in `fastagent.config.ts`, run on `harness: "dsh"` with kernel-enforced OS sandboxing (`workspace` or `read-only`), or isolate the agent in a container / AgentCore microVM.

## 2. Create the agent

```bash
npm install -g @fastagent-sh/fastagent
fastagent init my-agent
cd my-agent
```

An agent lives in its own directory, beside any project it operates on. `init` installs dependencies and creates the first git commit. Stay in `my-agent/` for the remaining steps: inside an agent directory, the global `fastagent` binary automatically runs the agent's installed version. Without a global install, use `npx @fastagent-sh/fastagent <command>` (never `npx fastagent`, which is an unrelated npm package).

## 3. Set up TypeScript

Write tools, helpers, and tests in TypeScript. Node ≥ 24.15 executes TypeScript natively by stripping types, so:
- import relative modules with `.ts` extensions (`../lib/batches.ts`) and types with `import type`;
- avoid non-erasable syntax (enums, namespaces, parameter properties, decorators, JSX).

```bash
npm install --save-dev typescript@^7.0.2 @types/node@22
npm pkg set 'scripts.typecheck=tsc --noEmit' 'scripts.test=node --test test/*.test.ts'
mkdir -p lib test skills/review-batches src/tools
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

## 4. Add a prompt, a skill, and a portable tool

Below is a self-contained offline example: an agent that plans proposal review batches.

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
import { defineTool } from "@fastagent-sh/fastagent";
import { batchCount } from "../../lib/batches.ts";

export default defineTool({
  name: "plan-batches",
  description: "Count review batches for a non-negative item count and a positive batch size.",
  parameters: {
    type: "object",
    properties: {
      items: { type: "integer", minimum: 0 },
      size: { type: "integer", minimum: 1 },
    },
    required: ["items", "size"],
  } as const,
  execute: async ({ items, size }) => JSON.stringify({ batches: batchCount(items, size) }),
});
```

`defineTool` from `@fastagent-sh/fastagent` works identically on both `pi-durable` and `dsh`. It accepts plain JSON Schema (`as const`), Zod v4 (or any Standard JSON Schema v1 library), or `@earendil-works/pi-schema`. Parameters are validated before `execute` runs. A tool that needs secrets wraps itself in `needs(["NAME"], (secrets) => defineTool(...))`. Place shared helper modules outside `src/` (here in `lib/`).

**`test/batches.test.ts`**

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { batchCount } from "../lib/batches.ts";
import planBatches from "../src/tools/plan-batches.ts";

test("batch planning calculates counts, and the tool answers with them", async () => {
  assert.equal(batchCount(5, 2), 3);
  // This tool uses neither the harness api nor context.
  const result = await planBatches.execute({ items: 5, size: 2 }, {} as never, {} as never);
  assert.deepEqual(result.output, [{ type: "text", text: '{"batches":3}' }]);
});
```

Verify everything offline with no model or credentials:

```bash
npm run typecheck
npm test
fastagent info --json      # lists the plan-batches tool and /skill:review-batches
```

To verify type checking is active, temporarily change `batchCount(5, 2)` to `batchCount("5", 2)` in `test/batches.test.ts` and confirm `npm run typecheck` fails, then restore it.

## 5. Send one real message

Choose the provider and model with the owner. Check readiness with `fastagent login <provider/model-id> --check` (exits `0` when ready):

- **Account sign-in (OAuth):** `fastagent login <provider> --method account --json` returns the `terminal_command` the owner runs in their own terminal and a `check_command` to verify once done.
- **API key:** `fastagent login <provider> --method api-key --json` names the environment variable and `.secrets/.env` file for the owner to populate.

**Never ask the owner to paste credentials into an agent conversation**, and keep secrets out of commits, issues, and logs.

Set `model: "provider/model-id"` in `fastagent.config.ts`, then run one live invocation:

```bash
fastagent invoke "Use plan-batches for 5 proposals at 2 per batch. Do not send anything."
```

This makes a real model call (which may incur cost). The answer writes to `stdout`; tool calls and session info write to `stderr`. Exit code is `0` only when the message ends `completed`. Inspect both the answer and tool usage, not only the exit code. Use `--json` for structured NDJSON events, `--session <id>` to continue a session, or `--conversation <name>` to reuse a caller-named conversation.

For ongoing iteration, run `fastagent dev`: prompt, `AGENTS.md`, skill, and template edits apply on the next message, and `src/` edits restart the worker cleanly. Restart `dev` manually after editing files outside `src/` (such as `lib/`).

## 6. Embed in an application (optional)

Build the agent with `fastagent build`, open it with `openAgent(definition, { root, secrets, env })`, and call the [Agent API](agent-api.md) (`sessions.create`, `messages.send`, `messages.stream`, or `invoke`). Your app owns authentication, tenancy, and business data. See [Embedding](embedding.md).

## 7. Verify and deploy

Choose the host with the owner and review [Deploy](deploy.md) (or [AgentCore](agentcore.md) for per-user microVM isolation on AWS).

```bash
fastagent deploy init docker   # or compose, fly, railway, agentcore
fastagent deploy check         # verifies the definition loads and leaks no local secrets or state
```

The owner supplies runtime values (`FASTAGENT_API_KEY`, model API key, declared `needs` secrets) via the host's secret store or env file—never through a chat transcript. Deployed instances can also authenticate model providers remotely with `fastagent login <provider> --url <url>` (persisted in the instance's durable storage).

Verify the live deployment:

```bash
fastagent invoke --url https://<your-host> "hello"
```

Or save it as a named remote (`fastagent remote add prod https://<your-host> --key '$PROD_AGENT_KEY'`) and use `--remote prod` across `invoke`, `login`, `logout`, and [`@fastagent-sh/pi-remote`](remotes.md).

What survives where in a deployment:

| Data | Persistence |
| --- | --- |
| Prompt, skills, code | Baked into the container image; updated on new deploys |
| Sessions, conversations, remote auth | Persistent volume at `/data` (SQLite) or PostgreSQL / Aurora DSQL (`FASTAGENT_DATABASE_URL`) |
| Business records & external artifacts | Your own database or external system; tool side effects should tolerate retries |

## 8. Report what you verified

| Check | Proves | Does not prove |
| --- | --- | --- |
| `npm run typecheck`, `npm test`, `fastagent info --json` | Types, helper/tool logic, definition assembly | Live model behavior |
| `fastagent invoke` | Model call, tool schema, and tool execution | Deployment config |
| `fastagent deploy check` | Build context leaks no local secrets or state | Live host networking |
| `fastagent invoke --url` / `--remote` | Deployed service answers over the Agent API | Every downstream side effect |

Report exact commands run, their outcomes, remaining owner actions, and anything not tested. Keep `.secrets/` and `.fastagent/` uncommitted, and stop any temporary servers you started.
