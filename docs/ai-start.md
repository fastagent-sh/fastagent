---
title: Develop an Agent with FastAgent
description: "The agent development guide for humans and coding agents: responsibilities, TypeScript tools, local checks, native channels, scheduling, deployment, and durable state."
status: current
---

# Develop an Agent with FastAgent

This is the starting point for **agent authors**, including coding agents working on an author's behalf.
Build on existing files and use FastAgent's public APIs and CLI. The repository's `AGENTS.md`,
[contribution workflow](../CONTRIBUTING.md), and internal design notes are for maintaining FastAgent itself.

Follow one path:

```text
inspect existing files and constraints
  → initialize once
  → define responsibilities, skills, and typed tools
  → inspect, typecheck, and test locally
  → add a native channel with owner-approved authentication
  → verify a real conversation and any proactive delivery
  → generate deployment artifacts
  → deploy with --run and verify the selected host
```

For a short first run, see [Quickstart](quickstart.md). Use the references linked below for details;
there is no additional workflow engine or required application build system.

## 1. Decide responsibilities before writing code

Agree on the agent's ongoing goal, inputs, success criteria, allowed systems and recipients, and actions
that need approval. Inspect the existing project, its `AGENTS.md`, package manifests, and agent files.
Preserve existing code, context, credentials, and deployment ownership.

| Responsibility | Put it in | Decision rule |
|---|---|---|
| Identity, ongoing goal, standing instructions, approval policy | `persona.md` | Describe what the agent is responsible for and when it must ask. |
| Project facts and conventions | `AGENTS.md` and existing project documents | Keep project context separate from the agent's identity. FastAgent reads the agent's own `AGENTS.md` and walks workspace ancestors for project context. |
| Reusable methods and domain knowledge | `skills/<name>/SKILL.md` | Explain when to use a method and what good work looks like; let the agent choose it. |
| Deterministic operations and external-system access | `tools/<name>.ts` | Expose a small typed capability with runtime input validation, useful results, and visible failures. |
| Event ingress and conversational replies | `channels/` | Start with a first-party channel. It owns protocol verification and routing; chat integrations also deliver normal replies. GitHub is ingress-only. |
| Clock triggers and deliberate follow-ups | `schedules/` and the opt-in `wake` tool | State the work and its recipient. A timer triggers a turn; it does not deliver the reply. |
| Model, serving, and deployment choices | `fastagent.config.*` | Keep configuration declarative. Use [supported keys](configuration.md#config-file). |
| Credentials and machine state | `.secrets/`, `.state/`, or their configured roots | Let FastAgent manage auth, journals, channel state, and scheduling records. Preserve them according to the host. |
| Business notes and decisions | Existing working files or an explicitly chosen durable store | Record sources, approval decisions, outcomes, and pending work. A session journal is not a business database. |

For a research agent, put the research method in a skill, expose searches and deterministic calculations
as tools, and let the agent choose sources, tool combinations, and follow-ups. Avoid hard-coding that
reasoning into a business pipeline by default. A host-owned queue or fixed workflow is appropriate when
the product actually requires predetermined ordering, transactions, or other deterministic guarantees.

Enforce authorization, destination restrictions, spending limits, and approval requirements in the
appropriate application, tool, or external-system boundary. **A prompt or typed tool is not a sandbox.**
Directory agents have coding tools, including a shell; authored code can access the process's files,
network, and credentials. Constrain the whole process when isolation is required. The default
`POST /invoke` route has no authentication; protect it before exposing it beyond a trusted environment.

## 2. Choose placement and initialize once

The **workspace** is the directory passed to FastAgent: the agent's working directory and deployment
build context. The **agent directory** holds `fastagent.config.*` and the definition. They can be different
directories or the same directory.

| Situation | Placement |
|---|---|
| New agent or an agent for an existing project | `fastagent init [workspace]` creates `workspace/fastagent/`; existing workspace files stay untouched. |
| A standalone agent repository or an existing package that is itself the agent | `fastagent init . --flat` puts the definition in the current directory and keeps existing files. Review retained package and ignore files. |
| An existing application embeds the agent | Keep the application's layout. A nested definition is convenient; the app retains auth, routes, database, and deployment. See [embedding](#8-embed-only-what-the-application-needs). |

A config file identifies an agent, not its directory name. Check the workspace itself and its direct
children for `fastagent.config.ts`, `.js`, or `.mjs` before running `init`. Reuse an existing definition.
`--agent-dir bot` selects another name; multiple sibling agents are selected with `FASTAGENT_AGENT`.
See [Configuration](configuration.md#more-than-one-agent). Optional directories remain optional.

The example below uses a **fresh, default nested scaffold**. Install the CLI once, then run:

```bash
npm install -g @fastagent-sh/fastagent
fastagent init my-agent
cd my-agent
```

For an existing project, run `fastagent init .` from that project's root instead. Do not create an empty
workspace that cuts the agent off from the project it should work on.

```text
my-agent/                         # workspace; run FastAgent commands here
└── fastagent/                    # agent directory; install its dependencies here
    ├── persona.md
    ├── skills/writing-great-skills/
    ├── tools/fetch-url.ts
    ├── fastagent.config.mjs
    ├── package.json              # type: module; FastAgent is a local dependency
    ├── .secrets/.env.example
    └── .gitignore
```

`init` installs dependencies in `fastagent/`. If installation fails, run `npm --prefix fastagent install`
before continuing. `--no-install` defers that install; `--minimal` omits the code tool and package manifest.
A global CLI installation alone does not make package imports available to authored tools.

**Working-directory convention for the rest of this guide:** stay in `my-agent/`, the workspace.
Use `npm --prefix fastagent ...` for the nested package. Running `fastagent dev` or `deploy` after
`cd fastagent` intentionally changes the workspace and build context to the agent directory itself.
For a flat agent, omit the `fastagent/` path prefix and npm's `--prefix fastagent`.

## 3. Use TypeScript for new authored code

Prefer **TypeScript for tools, channels, schedules, library helpers, and tests**. Runtime discovery also
supports JavaScript (`.js` and `.mjs`); existing JavaScript remains valid. Keep the generated
`fastagent.config.mjs`, Dockerfile, YAML/JSON host configuration, and generated deployment JavaScript in
their generated formats. Those artifacts do not set the language for business code.

Use **Node >= 22.19** (`node --version`) and ESM (`"type": "module"` in the agent's `package.json`, already
set by the default scaffold). Node runs erasable TypeScript directly. It removes types without checking
them and does not read `tsconfig.json` to transform code or resolve aliases.

- Use explicit `.ts` extensions for relative source imports, such as `../lib/batches.ts`.
- Use `import type` for types that have no runtime value.
- Avoid enums, runtime namespaces, constructor parameter properties, import aliases, decorators, and
  JSX in this no-build path. Native type stripping does not compile them into JavaScript.
- Keep an existing application's bundler when it needs one. A bundler or `tsx` is not required for this
  example. Published packages should ship JavaScript and declarations, as FastAgent does.

See [Node 22.19's TypeScript support](https://nodejs.org/download/release/v22.19.0/docs/api/typescript.html).

Install compatible development dependencies and add scripts to the **agent package**:

```bash
npm --prefix fastagent install --save-dev typescript@^7.0.2 @types/node@22
npm --prefix fastagent pkg set 'scripts.typecheck=tsc --noEmit' 'scripts.test=node --test test/*.test.ts'
mkdir -p fastagent/lib fastagent/test fastagent/skills/review-batches
```

For an existing package, merge with its current scripts and TypeScript configuration instead of
replacing them. The following strict baseline checks authored source without emitting build artifacts.
Extend `include` when adding other source directories.

**`fastagent/tsconfig.json`**

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
  "include": ["tools/**/*.ts", "channels/**/*.ts", "schedules/**/*.ts", "lib/**/*.ts", "test/**/*.ts", "fastagent.config.ts"]
}
```

`skipLibCheck` skips dependency declaration checking, not your source. `tsc --noEmit` provides static
checking; successfully executing a `.ts` file proves neither type safety nor input validity.

## 4. Add a small, testable capability

This offline example is an agent that prepares review batches. Adapt the freshly scaffolded persona;
preserve an existing agent's responsibilities when applying the example elsewhere.

**`fastagent/persona.md`**

```markdown
# Review assistant

Help the owner review project proposals in manageable batches. Choose relevant sources and methods,
separate evidence from assumptions, and retain the owner's decisions in the agreed working notes.
Use review-batches when planning a review and plan-batches for the batch count.
Ask before sending messages, publishing changes, or spending money. Record pending approvals instead
of treating silence as permission.
```

**`fastagent/skills/review-batches/SKILL.md`**

```markdown
---
name: review-batches
description: Plan manageable batches when the owner asks to review a set of proposals.
---

Confirm which proposals are in scope and the owner's preferred batch size. Use plan-batches for the
count. Group related proposals, explain uncertain evidence, and present a draft plan for approval.
```

**`fastagent/lib/batches.ts`**

```ts
export function batchCount(items: number, size: number): number {
  return Math.ceil(items / size);
}
```

**`fastagent/tools/plan-batches.ts`**

```ts
import { defineTool, z } from "@fastagent-sh/fastagent";
import { batchCount } from "../lib/batches.ts";

export default defineTool({
  description: "Count review batches for a non-negative item count and a positive batch size.",
  input: z.object({
    items: z.number().int().nonnegative(),
    size: z.number().int().positive(),
  }),
  execute({ items, size }) {
    return { batches: batchCount(items, size) };
  },
});
```

The filename supplies the tool name. `defineTool` infers `items` and `size` from the Zod schema and
validates incoming arguments before calling the body. TypeScript annotations alone do not validate
external JSON. Import `z` from FastAgent so schema construction and conversion use the same Zod copy.
Keep helpers outside `tools/`, whose files must default-export tools. Add IO and authorization checks
at the boundary that performs the real operation; keep imports free of network calls and side effects.

**`fastagent/test/batches.test.ts`**

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { batchCount } from "../lib/batches.ts";
import planBatches from "../tools/plan-batches.ts";

test("batch planning calculates counts and validates external arguments", async () => {
  assert.equal(batchCount(5, 2), 3);
  const result = await planBatches.execute("test", { items: 5, size: 2 });
  assert.deepEqual(result.details, { batches: 3 });
  const invalid = await planBatches.execute("invalid", { items: 5, size: 0 });
  assert.match(JSON.stringify(invalid.content), /Invalid arguments:/);
});
```

Run from the workspace, without a model or credentials:

```bash
npm --prefix fastagent run typecheck
npm --prefix fastagent test
fastagent tool plan-batches '{"items":5,"size":2}'
fastagent info --json
```

The tool prints `{"batches":3}`. Inspection should show the persona, `review-batches` skill, and
`plan-batches` tool, with no load failures. Check diagnostics as well as the exit code: a broken tool
can be reported and skipped. `info` inventories channels; only serving verifies that they actually load.

To confirm static checking is active, temporarily change `batchCount(5, 2)` in the test to
`batchCount("5", 2)`. `npm --prefix fastagent run typecheck` must fail; restore the valid call afterward.
Validation failures return tool error content, so a direct tool test checks that content rather than
expecting a thrown exception.

To reuse an existing Agent Skill, run `fastagent add skill <source>` with a git source such as
`owner/repo/path`, a local path, or a name from your global skill directories. Review its contents and
permissions before relying on it. See [CLI reference](cli.md).

## 5. Authenticate and verify one real turn

Choose a provider and model with the owner. `fastagent models` lists available specifications.
Ask the owner to run `fastagent login` in this workspace's terminal, or have them configure an approved
provider key in `fastagent/.secrets/.env`. Keep credentials out of chat transcripts, issue comments,
source files, and logs. The CLI reads the agent's `.secrets/.env`, not a workspace-root `.env`.

Set `model: "provider/model-id"` in the existing `fastagent.config.mjs`, preserving its export. A terminal
picker can also set the model; unattended invocations require an explicit model. The config value must
be present before deployment: a builder's `--model` flag or environment selection does not travel in
an image. See [models and auth](configuration.md).

```bash
fastagent invoke "Use plan-batches for 5 proposals at 2 per batch. Do not send anything."
```

This makes a real model request and may incur cost. Verify tool use and the answer, not just successful
process exit. For continuous local development, ask the owner to run:

```bash
fastagent dev --bind 127.0.0.1
```

`dev` is a long-running server. Edits to `persona.md`, `AGENTS.md`, and skills are read on the next turn.
With watching enabled, changes under the agent's `tools/`, `channels/`, `schedules/`, and `extensions/`
restart the worker, as do changes to its `fastagent.config.*`, `package.json`, `models.json`, and resolved
`.env` (only when that file is inside the agent directory).

**After editing `fastagent/lib/batches.ts` or another imported helper outside those watched directories,
stop and restart `fastagent dev`.** `lib/` is not watched, and imported modules remain cached in the
running worker. `start` serves without watching. `chat` opens the same definition in an interactive TUI.
A coding agent should background servers with a cleanup path or delegate them to the owner.

## 6. Add a native channel

A file in `channels/` enables a channel. Prefer the existing integrations over application-authored
webhook servers, token refresh loops, or reply pipelines:

| Channel | Command from the workspace | Owner action and reference |
|---|---|---|
| GitHub | `fastagent add github` | Approve repository access and configure its webhook; adapt the event-to-intent mapping. [GitHub](github.md) |
| Telegram | `fastagent add telegram` | Supply the bot token and webhook verification secret. [Telegram](telegram.md) |
| Slack | `fastagent add slack` | Complete interactive app configuration and OAuth installation. [Slack](slack.md) |
| Feishu | `fastagent add feishu` | Scan to approve app creation and publish its version in the console. [Feishu](feishu.md) |
| Lark | `fastagent add lark` | Complete international-console app/credential setup. [Lark compatibility](feishu.md) |

After owner-approved setup, use `fastagent dev --tunnel` for webhook testing (`cloudflared` required).
Confirm each channel loads, inspect registration results, and send a real message from the authorized
account. A URL verification challenge proves reachability, not a completed conversation. Keep manual
console steps visible. Rename a channel to, for example, `slack.ts.disabled` to disable it; a broken
enabled channel must fail serving instead of silently disappearing.

### Slack installation and credential ownership

`fastagent add slack` scaffolds both the channel and `slack-send`, then offers single-workspace internal-app
onboarding. The owner chooses visibility, supplies App Configuration access/refresh tokens through hidden
prompts, and approves installation in Slack. This enables Slack's irreversible Agent messaging experience;
platform plan requirements and the manual `--no-onboard` path are in [Slack onboarding](slack.md#internal-app-onboarding).

The credentials and where each lives are one table in [Slack → Credentials](slack.md#credentials): the
App Configuration Token pair stays on the builder machine (`onboarding.json`), the OAuth client
credentials are spent on the install, and the runtime has exactly `SLACK_BOT_TOKEN` and
`SLACK_SIGNING_SECRET`. Retain the builder's onboarding state for automated Request URL registration;
without it the CLI reports the manual console action. `fastagent add slack --replace-config` replaces
only the builder's App Configuration credentials.

`slack-send` delivers through the mounted channel's transport (`slackTransport(ctx.cwd)`); every
`fastagent add slack` rewrites `tools/slack-send.ts`.

### Replies and proactive delivery are different

Telegram, Slack, and Feishu/Lark chat turns already have framework-managed replies. Do not call a send
tool merely to repeat that reply. GitHub is an [ingress-only adapter](github.md): commenting or reviewing
requires explicit tools. Sending a generated file or contacting someone outside the current turn is an
outbound action requiring a recipient and the appropriate approval/policy checks.

Schedules and wakes have no channel carrying their plain answer. Use a supported send tool with an
owner-approved destination and optional thread, and record its outcome. Incoming attachments are input;
uploading an artifact is a separate operation. Confirm real delivery and relevant credential renewal,
not just that the model said it sent something. If the first-party path has a confirmed gap, report or
track it upstream and state the limitation instead of silently building a replacement serving system.

## 7. Add clock triggers deliberately

After adding Telegram and selecting an approved recipient, this is a schedule file. Replace
`OWNER_APPROVED_CHAT_ID` before running it; no destination is inferred from a previous chat.

**`fastagent/schedules/daily-review.ts`**

```ts
import { defineSchedule } from "@fastagent-sh/fastagent";

export default defineSchedule({
  cron: "0 9 * * *",
  tz: "America/New_York",
  prompt: "Review pending proposals and use telegram-send to send a short digest to Telegram chat OWNER_APPROVED_CHAT_ID. Leave unapproved actions pending.",
});
```

Create `fastagent/schedules/` only when needed. Inspect and test from the workspace:

```bash
fastagent schedule list
fastagent fire daily-review
fastagent schedule history daily-review
fastagent schedule history wake
```

These commands read the selected local state root, not a deployed host's state.

`fire` runs one real turn immediately and prints its reply without advancing the cron fire state.
It can still perform real tool side effects and update conversation history; it is not a dry run.
Serving-time runs are recorded in the schedule audit. `invoke` and `fire` do not mount the serving-time
`wake` tool or prove that a future timer fires.

Enable `selfSchedule: true` in the existing config only when autonomous follow-ups are wanted. Then test
an actual `wake` while serving, including its eventual action and delivery. Use `fastagent schedule list`
and `fastagent schedule cancel <id>` to inspect or cancel pending local wake-ups.

| Execution posture | Clock and persistence requirements |
|---|---|
| Resident `dev` / `start` or embedded `createAgentService` | The process runs the scheduler. Keep one active scheduler with durable state; a sleeping/stopped process cannot fire timers. Fly/Railway deployment gates account for time triggers. |
| AgentCore webhook/schedule ingress | EventBridge delivers cron slots and, with `selfSchedule`, external wake alarms. Scale-to-zero is supported on this path; no resident timer is required. |
| Direct `InvokeAgentRuntime` sessions | Separate from ingress. They lack the ingress S3 snapshot and external wake-alarm guarantees. Do not use a successful direct invocation to claim cross-deploy memory or future wake delivery. |

See [AgentCore execution and persistence](deploy.md#aws-bedrock-agentcore) and
[schedule authoring](api-reference.md#schedule-authoring) for the exact guarantees.

## 8. Embed only what the application needs

Install FastAgent in the application package that imports it as well as in a separate agent package
that imports it. A flat placement can use one manifest; keep package versions aligned.

- For the whole service, use `createAgentService(workspace)`, mount its Fetch `handler`, await `ready`,
  and close the service on application shutdown. This includes discovered channels and scheduling.
- For invocation only, use `createPiAgentFromDefinition` / `createPiAgentFromDir` and
  `createInvokeHandler(agent)`, or consume `agent.invoke` directly. An invoke handler alone does not
  mount native channels or start schedules.

The application owns authentication, users, session ownership, database, and deployment. Preserve raw
webhook bodies when mounting under a framework. Follow [Embedding](embedding.md) rather than rebuilding
the service assembly, Slack transport, or a separate scheduler. `ExecutionEnv` is not process isolation.

## 9. Deploy and preserve the right data

Choose a host, cost budget, credentials, and public ingress with the owner. Generate only the selected
host's artifacts from the **workspace**, preserving the CLI's formats and existing user-owned files:

| Host | Generate only | Deploy after approval |
|---|---|---|
| Local Docker | `fastagent deploy docker` | `fastagent deploy docker --run` |
| Fly | `fastagent deploy fly` | `fastagent deploy fly --run` |
| Railway | `fastagent deploy railway` | `fastagent deploy railway --run` |
| AgentCore | `fastagent deploy agentcore` | `fastagent deploy agentcore --run` |

Generation prints a runbook and writes artifacts; it does not deploy. After reviewing the selected
host's plan and completing approved authentication, run the matching `--run` command.

Docker needs Docker/Compose; Fly and Railway need their authenticated CLIs. AgentCore needs AWS CLI v2,
an approved region, and local Docker/buildx for its arm64 image. `fastagent deploy agentcore` generates
the CloudFormation topology, forwarder, and clock wiring required by the definition; `--run` provisions
and verifies it. Review [Deploy](deploy.md) before authorizing resource creation or cost.

Put the model in config and declare extra required secret **names** in `deploy.secrets`. CLI-managed
registration uses the selected host's ingress and local onboarding credentials where supported. Finish
any reported manual steps, then verify a real conversation and any scheduled/proactive delivery at that
host. AgentCore's public webhook URL belongs to its forwarder; direct runtime invocations use AWS IAM.
`fastagent logs agentcore --follow` reads runtime logs; `--source forwarder` selects ingress logs.

| Data | What must survive, and how |
|---|---|
| Versioned persona, skills, tools, config, and package lockfile | Commit approved changes and redeploy. The workspace is baked into the image; only the agent package's dependencies are installed. A machine's unpushed edits are not a durable definition update. |
| Runtime session journals, channel state, pending work, schedule audit | Preserve the resolved state root. Resident recipes use durable storage and one replica; AgentCore snapshots the ingress state tree to S3. |
| Rotated model and Slack bot credentials | Preserve both the selected secrets/state roots. AgentCore nests runtime secrets inside its snapshotted tree. Treat backups as credential-bearing. Keep builder-only Slack onboarding credentials local. |
| Business notes, approvals, generated artifacts | Choose existing durable storage, explicitly synchronized git, or an appropriate durable state-root location. Files elsewhere in the container/workspace can disappear on replacement. Verify the chosen path, retention, and access policy. |

Turn recovery is channel-specific: Telegram, Slack, and Feishu/Lark replay accepted turns at least once,
so side effects must tolerate repetition. GitHub post-ACK work has no durable replay.

`fastagent info` shows resolved paths. Do not assume every file, session, or wake survives every redeploy:
AgentCore's snapshot covers its ingress session, not arbitrary direct runtime sessions. A lost state
volume or S3 bucket is a separate loss event. See [what deploy bakes](deploy.md#what-deploy-bakes),
[host guarantees](deploy.md), and [state configuration](configuration.md#machinery-state-and-secrets).

## 10. Report what was actually verified

Keep these checks distinct. Use the smallest relevant ones, and make credentialed or paid checks opt-in.

| Check | What it proves |
|---|---|
| Typecheck, unit test, direct tool execution, `info` | Source types, exercised runtime validation/logic, and definition inspection. These do not prove model or channel behavior. |
| One real `invoke` or `fire` | A provider call and the exercised tool path. It does not verify timers, webhook ingress, or deployment. |
| URL verification and a real channel conversation | Report registration separately from actual receipt and framework-managed reply delivery. |
| Proactive message/file and a fired schedule/wake | Verify the intended recipient, observable delivery, and the selected clock path. Check token renewal when applicable. |
| Generated plan / accepted CloudFormation template | Artifact generation or platform template validation only; neither proves deployed operation. |
| Deployment and a real conversation/delivery on that host | Runtime operation on the selected host, beyond creation or health checks. |
| Controlled restart/redeploy and continued work | The tested session, notes, credentials, and pending work survive that event on that storage path. Obtain approval before interrupting work. |

Before handing back the agent, report commands and outcomes, any manual steps or known gaps, and what
was not tested. Mocked results stay labeled offline. Keep secrets and machine state out of commits,
clean up temporary servers/resources, and consult [Troubleshooting](troubleshooting.md) for failures.
