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
| Ongoing goal, standing instructions, approval policy | `SYSTEM.md` | Describe what the agent is responsible for and when it must ask. It is the agent's system prompt, read for every message. |
| Project facts and conventions | The project's own files, its `AGENTS.md` among them, with the project declared as [content](configuration.md#content) | The agent reads them when it works in the project; nothing of the project is added to its prompt. To have it read the project's `AGENTS.md` before it changes anything, say so in the entry's `description`. |
| Reusable methods and domain knowledge | `skills/<name>/SKILL.md` | Explain when to use a method and what good work looks like; let the agent choose it. |
| Deterministic operations and external-system access | `src/tools/<name>.ts` | Expose a small typed capability with validated input, useful results, and visible failures. |
| Event ingress and conversational replies | `src/channels/` | Start with a first-party channel. It owns protocol verification and routing; chat integrations also deliver normal replies. |
| Clock triggers and follow-ups | `src/schedules/` and the `wake` tool (given on every serve) | State the work and its recipient. A timer sends the agent a message; it does not deliver the reply. |
| Model, providers, and deployment choices | `fastagent.config.ts` (`defineAgent`) | Keep configuration declarative. Use [supported keys](configuration.md#config-file). |
| Credentials and machine state | `.secrets/`, `.state/`, or their configured roots | Let FastAgent manage auth, the instance's storage, channel state, and scheduling records. Preserve them according to the host. |
| Business notes and decisions | Existing working files or an explicitly chosen durable store | Record sources, approval decisions, outcomes, and pending work. A session's history is not a business database. |

For a research agent, put the research method in a skill, expose searches and deterministic calculations
as tools, and let the agent choose sources, tool combinations, and follow-ups. Avoid hard-coding that
reasoning into a business pipeline by default. A host-owned queue or fixed workflow is appropriate when
the product actually requires predetermined ordering, transactions, or other deterministic guarantees.

Enforce authorization, destination restrictions, spending limits, and approval requirements in the
appropriate application, tool, or external-system boundary. **A prompt or typed tool is not a sandbox.**
Directory agents have coding tools, including a shell; authored code can access the process's files,
network, and credentials. Constrain the whole process when isolation is required. A served agent is reached only
through its channels, and each channel verifies the platform calling it.

## 2. Create the agent beside what it works on

An agent is a directory of its own. It holds `fastagent.config.ts`, the definition, and the local instance's
`.state/`, `.secrets/` and `content/` (where it reaches its content: links and clones), and it is the agent's working directory. What the agent works on (a project, a folder) is
declared as its **content**; the agent never sits inside it, and a project never sits inside the agent.

| Situation | Do |
|---|---|
| A new agent | `fastagent init my-agent`. Without content it works only in its own directory. |
| An agent for an existing project | `fastagent init <agent dir> --content <project>`: the agent lives beside the project, which gets no writes from `init`. |
| An existing application embeds the agent | Keep the definition in its own directory beside the application; the app retains auth, routes, database, and deployment. See [embedding](#8-embed-only-what-the-application-needs). |

A config file identifies an agent, not its directory name. Before running `init`, check whether the owner already has an
agent (a directory holding `fastagent.config.ts`) and reuse it. `fastagent content add <dir>` adds content later, and
`--readonly` adds a directory the agent only knows: a GitHub checkout is declared as its repository in `context.json`,
any other directory bound on this machine only in `context.local.json`. See [content](configuration.md#content).
Optional directories remain optional.

The example below uses a **fresh, default scaffold**. Install the CLI once, then run:

```bash
npm install -g @fastagent-sh/fastagent
fastagent init my-agent
cd my-agent
```

```text
my-agent/                         # the agent directory; run FastAgent commands here
├── SYSTEM.md
├── skills/writing-great-skills/
├── fastagent.config.ts
├── package.json                  # type: module; FastAgent and the packages its code is written against
├── .secrets/.env.example
└── .gitignore
```

Code goes in `src/`: `src/tools/`, `src/extensions/`, `src/channels/` and `src/schedules/`, one module per file, each
default-exporting what its directory holds. FastAgent generates `.fastagent/registry.ts` from them each time the agent
opens.

`init` installs dependencies in the agent directory. If installation fails, run `npm install` there before
continuing. `--no-install` defers that install.
A global CLI installation alone does not make package imports available to authored tools.

**Working-directory convention for the rest of this guide:** stay in `my-agent/`, the agent directory.

## 3. Use TypeScript for new authored code

Prefer **TypeScript for tools, channels, schedules, library helpers, and tests**. A module in `src/` may also be
JavaScript (`.js` and `.mjs`). The config file is always `fastagent.config.ts`.
Keep the generated Dockerfile, YAML/JSON host configuration, and generated deployment JavaScript in their
generated formats. Those artifacts do not set the language for business code.

Use **Node >= 24.15** (`node --version`) and ESM (`"type": "module"` in the agent's `package.json`, already
set by the default scaffold). Node runs erasable TypeScript directly. It removes types without checking
them and does not read `tsconfig.json` to transform code or resolve aliases.

- Use explicit `.ts` extensions for relative source imports, such as `../lib/batches.ts`.
- Use `import type` for types that have no runtime value.
- Avoid enums, runtime namespaces, constructor parameter properties, import aliases, decorators, and
  JSX in this no-build path. Native type stripping does not compile them into JavaScript.
- Keep an existing application's bundler when it needs one. A bundler or `tsx` is not required for this
  example. Published packages should ship JavaScript and declarations, as FastAgent does.

See [Node 24.15's TypeScript support](https://nodejs.org/download/release/v24.15.0/docs/api/typescript.html).

Install compatible development dependencies and add scripts to the **agent package**:

```bash
npm install --save-dev typescript@^7.0.2 @types/node@22
npm pkg set 'scripts.typecheck=tsc --noEmit' 'scripts.test=node --test test/*.test.ts'
mkdir -p lib test skills/review-batches src/tools src/schedules
```

For an existing package, merge with its current scripts and TypeScript configuration instead of
replacing them. The following strict baseline checks authored source without emitting build artifacts.
Extend `include` when adding other source directories.

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

`skipLibCheck` skips dependency declaration checking, not your source. `tsc --noEmit` provides static
checking; successfully executing a `.ts` file proves neither type safety nor input validity.

## 4. Add a small, testable capability

This offline example is an agent that prepares review batches. Adapt the freshly scaffolded instructions;
preserve an existing agent's responsibilities when applying the example elsewhere.

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
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { batchCount } from "../../lib/batches.ts";

export default defineTool({
  name: "plan-batches",
  description: "Count review batches for a non-negative item count and a positive batch size.",
  parameters: Type.Object({
    items: Type.Integer({ minimum: 0 }),
    size: Type.Integer({ minimum: 1 }),
  }),
  execute: async ({ items, size }) => ({
    output: [{ type: "text", text: JSON.stringify({ batches: batchCount(items, size) }) }],
  }),
});
```

A tool is pi-durable's `defineTool`: `parameters` is a TypeBox schema, from which `items` and `size` are typed, and the
harness validates a call's arguments against it before calling `execute`. TypeScript annotations alone do not
validate external JSON. A tool that reads a secret declares it: wrap it in `needs(["NAME"], (secrets) => defineTool(…))`
from `@fastagent-sh/fastagent`, and the agent refuses to start while the value is missing. A module directly in
`src/tools/` is a tool; a helper lives outside `src/`, as `lib/` does here. Add IO and authorization checks at the
boundary that performs the real operation; keep imports free of network calls and side effects.

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

Run from the agent directory, without a model or credentials:

```bash
npm run typecheck
npm test
fastagent info --json
```

Inspection should show the `plan-batches` tool and the `/skill:review-batches` command. A module that does not
load, or is not what its directory holds, is reported there; `dev` / `start` refuse to run on one.

To confirm static checking is active, temporarily change `batchCount(5, 2)` in the test to
`batchCount("5", 2)`. `npm run typecheck` must fail; restore the valid call afterward.

To reuse an existing Agent Skill, run `fastagent add skill <source>` with a git source such as
`owner/repo/path`, a local path, or a name from your global skill directories. Review its contents and
permissions before relying on it. See [CLI reference](cli.md).

## 5. Authenticate and verify one real message

Choose a provider and model with the owner. `fastagent models` lists available specifications, the providers
`fastagent.config.ts` declares included ([custom models](configuration.md#custom-models)).
`fastagent auth check --provider <id>` says whether the provider is ready (`ready`, exit 0). When it is not:

- An account (ChatGPT for `openai`, a Claude subscription for `anthropic`): run
  `fastagent login <provider> --method account --json`. It prints the address to open as an `open` line; give it
  to the owner, who signs in in the browser, and the command ends with a `result` line once they have.
- An API key: the owner sets it in `.secrets/.env`, or pipes it in themselves
  (`printf %s "$KEY" | fastagent login <provider> --method api-key`). The owner can also run `fastagent login` in a
  terminal, which asks for everything.

Keep credentials out of chat transcripts, issue comments, source files, and logs. The CLI reads the agent's
`.secrets/.env`, not a `.env` at its root.

Set `model: "provider/model-id"` in the existing `fastagent.config.ts`, preserving its export. A terminal
picker can also set the model; unattended invocations require an explicit model. A deployment resolves
from two sources only — that config value, or `FASTAGENT_MODEL` in `.secrets/production/.env`, which
`deploy` reads from the file and records in the release manifest. A `--model` flag is local to the run
that passes it, and `deploy` has none. See [models and auth](configuration.md).

```bash
fastagent invoke "Use plan-batches for 5 proposals at 2 per batch. Do not send anything."
```

This makes a real model request and may incur cost. `invoke` prints the answer on stdout and each tool call on
stderr, and exits non-zero unless the message completed: verify the tool use and the answer, not just the exit code.
`--json` prints the message's events as JSON lines instead (each tool call with its arguments and result, then the
outcome), for a check that asserts on them. Every run prints its session's id; `--session <id>` sends the next message into it, for
behavior that needs a second message. It opens the agent on storage of its own, so it runs beside a `dev` of the same agent
([CLI](cli.md#fastagent-invoke)). For continuous local
development, ask the owner to run:

```bash
fastagent dev
```

`dev` is a long-running server. Edits to `SYSTEM.md`, `AGENTS.md`, skills and prompt templates are read on the next
message. With watching enabled, changes under the agent's `src/` restart the worker, as do changes to its
`fastagent.config.ts`, `package.json`, and resolved `.env` (only when that file is inside the agent directory). The
restart waits for the messages running in the worker to finish (at most 10 minutes), so editing your own `src/` does
not cut off the message that made the edit; the change takes effect from the next message after the restart.

**After editing `lib/batches.ts` or another imported helper outside `src/`, stop and restart `fastagent dev`.**
`lib/` is not watched, and imported modules remain cached in the running worker. `start` serves without watching.
One `dev` or `start` holds the agent's storage at a time; a second is refused. A coding agent should background
servers with a cleanup path or delegate them to the owner.

## 6. Add a native channel

A module in `src/channels/` enables a channel. Prefer the existing integrations over application-authored
webhook servers, token refresh loops, or reply pipelines:

| Channel | Command from the agent directory | Owner action and reference |
|---|---|---|
| Telegram | `fastagent add telegram` | Supply the bot token and webhook verification secret. [Telegram](telegram.md) |
| Slack | `fastagent add slack` | Complete interactive app configuration and OAuth installation. [Slack](slack.md) |
| Feishu | `fastagent add feishu` | Scan to approve app creation and publish its version in the console. [Feishu](feishu.md) |
| Lark | `fastagent add lark` | Complete international-console app/credential setup. [Lark compatibility](feishu.md) |

After owner-approved setup, use `fastagent dev --tunnel` for webhook testing (`cloudflared` required).
Confirm each channel loads, inspect registration results, and send a real message from the authorized
account. A URL verification challenge proves reachability, not a completed conversation. Keep manual
console steps visible. Rename a channel to, for example, `src/channels/slack.ts.disabled` to disable it; a broken
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

`slack-send` delivers through the mounted channel's transport (`slackTransport(SLACK_BOT_TOKEN)`); every
`fastagent add slack` rewrites `src/tools/slack-send.ts`.

### Replies and proactive delivery are different

Telegram, Slack, and Feishu/Lark chat turns already have framework-managed replies. Do not call a send
tool merely to repeat that reply. Sending a generated file or contacting someone outside the current turn is an
outbound action requiring a recipient and the appropriate approval/policy checks.

Schedules and wakes have no channel carrying their plain answer. Use a supported send tool with an
owner-approved destination and optional thread, and record its outcome. Incoming attachments are input;
uploading an artifact is a separate operation. Confirm real delivery and relevant credential renewal,
not just that the model said it sent something. If the first-party path has a confirmed gap, report or
track it upstream and state the limitation instead of silently building a replacement serving system.

## 7. Add clock triggers deliberately

After adding Telegram and selecting an approved recipient, this is a schedule: its cron, and the prompt each fire
sends. Name the recipient in the prompt (a chat id is not a secret); no destination is inferred from a previous chat.

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

Each fire continues the schedule's own session, which the first one creates. Inspect from the agent directory:

```bash
fastagent schedules list
```

It reads the selected local state root, not a deployed host's state: the next fire, how the last one ended, and the
session it ran in. To try one now, `fastagent schedules run <name>` fires it as its clock would: in its own session,
with its claim recorded, exiting non-zero unless it completed. That is a real fire: it can perform tool side effects,
and it is refused while `dev` serves the agent. It does not prove that the clock fires at the next instant.

Every serve gives the agent the `wake` tool, so it can schedule its own follow-ups. Test an actual `wake` while
serving, including its eventual action and delivery. The agent cancels one with `unwake({ id })` from the session
that set it; `fastagent schedules unwake <id>` cancels any, such as one set during a schedule's fire.

| Execution posture | Clock and persistence requirements |
|---|---|
| Resident `dev` / `start`, or an app's `serve()` | The process runs the scheduler, with durable state; a sleeping or stopped process cannot fire timers. Fly/Railway deployment gates account for time triggers. |
| AgentCore | The container mirrors each schedule into a recurring EventBridge schedule and each wake-up into a one-shot, which wake it. Scale-to-zero is supported on this path; no resident timer is required. Its storage resets on deploy. |

See [AgentCore execution and persistence](deploy.md#aws-bedrock-agentcore) and
[schedules](configuration.md#schedules) for the exact guarantees.

## 8. Embed only what the application needs

Install FastAgent in the application package that imports it as well as in the agent package that imports it; keep
package versions aligned.

- To call the agent from the app, open it with `openAgent(agentDir)` and use the [Agent API](SPEC.md) on
  it: `sessions.create`, then `messages.send` with `wait`, or `messages.stream` for an answer as it is written. To serve
  it to the app's own users, write the routes the product needs over these calls, behind the app's authentication.
- To serve the agent's channels and schedules from the app too, `await agent.serve()`, mount its `fetch` (or `listen`
  on a port of its own), await `ready`, and `agent.close()` on shutdown.

The application owns authentication, users, database, and deployment. Preserve raw webhook bodies when mounting under
a framework. Follow [Embedding](embedding.md) rather than rebuilding the service assembly, Slack transport, or a
separate scheduler. Nothing in the assembly isolates the process.

One agent instance is one trust domain. Recording which user owns which session does not keep users apart: the
coding tools (`read`, `bash`) reach every session in the instance's storage, whichever user's message asked them to.
Users who must not see each other's conversations get an instance each, or an agent without tools that reach its
instance's storage and files ([security boundary](design/security-boundary.md#3-people-who-must-be-kept-apart)).

## 9. Deploy and preserve the right data

Choose a host, cost budget, credentials, and public ingress with the owner. Generate only the selected
host's artifacts from the **agent directory**, preserving the CLI's formats and existing user-owned files.
A `github` content entry is cloned on the host (put `GITHUB_TOKEN` in `.secrets/production/.env` for a private
repository or for pushes); a `local` entry stays on this machine, and the deployed agent works without it (`deploy` says so).
Copy reference material the agent only reads into the agent directory, outside `content/`, which every release
ships; move data it works on to a repository.

| Host | Generate only | Deploy after approval |
|---|---|---|
| Local Docker | `fastagent deploy docker` | `fastagent deploy docker --run` |
| Fly | `fastagent deploy fly` | `fastagent deploy fly --run` |
| Railway | `fastagent deploy railway` | `fastagent deploy railway --run` |
| AgentCore | `fastagent deploy agentcore` | `fastagent deploy agentcore --run` |

Generation prints a runbook and writes artifacts, including a new release ID; it does not deploy.
Review the [definition replacement policy](deploy.md#what-deploy-bakes) and the selected host's plan,
complete approved authentication, then run the matching `--run` command.

Docker needs Docker/Compose; Fly and Railway need their authenticated CLIs. AgentCore needs AWS CLI v2,
an approved region, and local Docker/buildx for its arm64 image. `fastagent deploy agentcore` generates
the CloudFormation topology, forwarder, and clock wiring required by the definition; `--run` provisions
and verifies it. Review [Deploy](deploy.md) before authorizing resource creation or cost.

Put the model in config and every value the deployment needs in `.secrets/production/.env`; `deploy` carries the whole
file, never the dev one. A
model without an API key there (an OAuth subscription) is logged in on the deployment by the owner, in a terminal:
`--run` starts `fastagent login --deployment <host>` once the box is up, and without a terminal it stops and names that
command ([Logging a deployment in](deploy.md#logging-a-deployment-in)). CLI-managed
registration uses the selected host's ingress and local onboarding credentials where supported. Finish
any reported manual steps, then verify a real conversation and any scheduled/proactive delivery at that
host. A deployed agent is reached through its channels and schedules, and on Docker, Fly and Railway through the
Agent API under `/v1`, whose key `deploy` writes into `.secrets/production/.env` ([The Agent API](deploy.md#the-agent-api)).
Check the deployment the way you checked the agent: `fastagent invoke --url <the URL deploy reports> "..."`, with the
same output and exit code. AgentCore's public webhook URL belongs to its forwarder; its IAM-gated door takes only the
deploy's `probe`.
`fastagent logs agentcore --follow` reads runtime logs; `--source forwarder` selects ingress logs.

| Data | What must survive, and how |
|---|---|
| Prompt files, skills, code, config, and package lockfile | The image holds the agent directory and installs its dependencies. Definition edits survive same-release restarts; a new release replaces the definition. Git is optional version control. |
| The instance's storage (`agent.sqlite`: sessions and messages), channel state, pending work, fired-slot claims | Keep the resolved state root on the host's volume. Docker, Fly, and Railway retain it across deploys. AgentCore's managed SessionStorage retains it across compute stop/resume, then resets on deploy or after 14 idle days. |
| Rotated model and Slack bot credentials | Keep both the selected secrets/state roots on the volume. A model login is the box's own (`fastagent login --deployment`); a redeploy keeps it. AgentCore clears them on deploy, so a login there is repeated after every deploy; an API key in the value file avoids it. Treat backups as credential-bearing. Keep builder-only Slack onboarding credentials local. |
| Business notes, approvals, generated artifacts | Locally, write ongoing work into content the agent works on. On a host, the agent's own directory is replaced by every release and local content is not deployed, so use an external store. |

An accepted message is durable: the agent answers it after a restart. Telegram, Slack, and Feishu/Lark also replay
accepted turns at least once, so side effects must tolerate repetition.

`fastagent info` shows resolved paths. Verify retention on the selected host; deleting its volume also
deletes the data it holds. See [what deploy bakes](deploy.md#what-deploy-bakes), [host guarantees](deploy.md),
and [state configuration](configuration.md#machinery-state-secrets-and-content).

## 10. Report what was actually verified

Keep these checks distinct. Use the smallest relevant ones, and make credentialed or paid checks opt-in.

| Check | What it proves |
|---|---|
| Typecheck, unit test, a tool's `execute` called in a test, `info --json` | Source types, exercised runtime validation/logic, and what the definition opens as. These do not prove model or channel behavior. |
| One real `invoke` (`--json` to assert on its events, `--session` for a second message) | A provider call, the exercised tool path, and the answer (exit code 0 only when completed). It does not verify timers, webhook ingress, or deployment. |
| `schedules run <name>` | One fire of the schedule, in its session, with its claim. It does not verify that the clock fires it. |
| URL verification and a real channel conversation | Report registration separately from actual receipt and framework-managed reply delivery. |
| Proactive message/file and a fired schedule/wake | Verify the intended recipient, observable delivery, and the selected clock path. Check token renewal when applicable. |
| Generated plan / accepted CloudFormation template | Artifact generation or platform template validation only; neither proves deployed operation. |
| `invoke --url <deployment>` | The deployed agent answers one message through its Agent API, with the deployment's model and credentials. It does not verify channel ingress or the clock. |
| Deployment and a real conversation/delivery on that host | Runtime operation on the selected host, beyond creation or health checks. |
| Controlled restart/redeploy and continued work | The tested session, notes, credentials, and pending work survive that event on that storage path. Obtain approval before interrupting work. |

Before handing back the agent, report commands and outcomes, any manual steps or known gaps, and what
was not tested. Mocked results stay labeled offline. Keep secrets and machine state out of commits,
clean up temporary servers/resources, and consult [Troubleshooting](troubleshooting.md) for failures.
