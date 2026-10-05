---
title: Agent model implementation
description: "How the agent model and its CLI are built on today's code: the one resolved value every consumer reads, the change by area, the decisions, and the stages that ship it."
type: design-doc
status: proposed
---

# Agent model implementation

**Status: proposed.** The technical design for [agent model](agent-model.md) and [agent CLI](agent-cli.md).
Tracking issue: [#684](https://github.com/fastagent-sh/fastagent/issues/684). This is a plan: as each stage lands,
what it decided moves into [core](core.md) and the user docs, and this note shrinks; it is deleted when the last
stage merges.

## 1. What is hard

Today "what the agent works on" is derived, in about fifteen places, from where the definition sits
(`resolvePlacement` in `src/paths.ts`: workspace = the agent directory's parent). The model replaces that with a
declaration whose meaning depends on where the instance runs: a local path, a checkout, a clone, a copy baked into
an image. The hard part is to compute that answer **once per process, in one function, and have every consumer read
the same value**: the prompt, the coding tools' working directory, skills, authored tools, `info`, `deploy`
preflight and the startup report. Two derivations of it would disagree, the way the run and observation planes
once did.

Everything else in this note is plumbing around that value or a separate, smaller change (the prompt, the
restart, the routine floor).

## 2. The resolved agent

One engine-neutral module owns the declaration and its resolution: `src/contexts/` (`declare.ts` pure,
`resolve.ts` with filesystem and git).

```ts
/** What an author writes in fastagent.config.ts `contexts` (validated by declare.ts). */
type ContextDeclaration =
  | { local: string; copy?: boolean; readonly?: boolean; name?: string }
  | { github: string; ref?: string; local?: string; readonly?: boolean; name?: string };

/** What every consumer reads: one entry per declared context, resolved for THIS instance. */
interface ResolvedContext {
  name: string;               // unique ignoring case, one segment of [A-Za-z0-9_-]
  kind: "local" | "copy" | "github";
  readonly: boolean;          // "knows" vs "works on"
  location: string;           // absolute directory on this instance
  origin: string;             // what the author declared, for display ("~/notes", "github acme/app@main")
  travels: boolean;           // a change here reaches other instances (github writable)
  notices: string[];          // said at startup: "checkout is on feat/x, declared main", "cloned afresh as app2"
}

interface ResolvedAgent {
  agentDir: string;           // the working directory, everywhere
  config: FastagentConfig;
  contexts: ResolvedContext[];
}
```

`resolveAgent(dir, place)` is the one function that answers where each context is. `place` is `"local"` or
`"host"` (the deployed `start`). It is **pure**: it reads the declaration and what is on disk, and neither touches
the network nor writes. Making a location real is a separate step (below).

| Declaration | `local` | `host` |
|---|---|---|
| `local` | The path; refused if missing or not a directory | Refused (preflight already refused the deploy) |
| `local` + `copy` | The path | `.state/contexts/<name>`, seeded from the image (§3.7) |
| `github` with a usable `local` | The checkout; `notices` when HEAD is not at `ref` | A clone in `.state/contexts/<name>` |
| `github` without one | A clone in `.state/contexts/<name>` | Same |

"Usable `local`" means the directory is a git checkout whose `origin` is `github.com/<owner>/<repo>`; anything else
is a notice and a clone, never a silent substitution. A location that does not exist yet (a clone not made, a copy
not seeded) resolves with a notice saying so.

**Materializing** (`materializeContexts`, in the same module) makes every location real: it clones, refreshes and
seeds copies. It is the only writer of `.state/contexts/`, it runs under a cross-process lock in the state root
(`proper-lockfile`, as `locked-file.ts` uses), and only two callers run it: a serving process when it starts, and
the deployed `start` before it serves. On a host that makes it the one owner of copies and clones alike;
`applyDeploymentRelease` no longer copies anything but the definition. Read-only commands (`info`,
`context list`, `fastagent tool`, the restart check of §3.8) resolve without materializing, so they never touch
the network or the disk, and `info` keeps its contract of creating nothing.

Its rules follow writability:

- **Read-only**: refreshed to `ref` when the process starts, and only when the remote moved. The new tree is built
  beside the old one and renamed into place, so a turn in another process reads one version or the other, never a
  half-reset tree.
- **Writable**: cloned or seeded once, then left alone, with a notice when the declared `ref` moved.
- Two processes starting together take the lock in turn; the second finds the clone made and does nothing.

Validation in `declare.ts`, all at load, all refusals naming the declaration: exactly one source key; `copy` only on
`local`; `ref` only on `github`; `path` refused as not yet supported; names unique ignoring case and spelled like
`isReleaseAgentName`; no declared location (a `local` path, a `github` `local`) contains the agent directory or sits
inside it.

**When it runs.** Resolution once per process start, before the assembly; materialization once per serving process
start, before resolution. Fetching per turn would put network and git on every turn. What is re-read per turn is the content at the resolved locations (`AGENTS.md`, skills), as the definition is
re-read today. A changed declaration is a config change, so it restarts the process (§3.8).

## 3. Change by area

### 3.1 Addressing (`src/paths.ts`, CLI)

`resolvePlacement`, `findPlacement`, `agentsAt`, `selectAgent`, `placementDeadEnd`, `agentDefinitionOwner` and
`DEFAULT_AGENT_DIRNAME` go. In their place, `resolveAgentDir(dir)`: `dir` holds `fastagent.config.ts` → it; `dir`
is inside an agent directory → refused naming its root; else refused with `fastagent init`. `findAgentDir(dir)` stays
for the commands that work without an agent (`login`, `models`), with the same rule. `FASTAGENT_AGENT` disappears
from `paths.ts`, `deploy/container.ts`, `deploy/secrets.ts`, `start.ts` and the `.env.example` template. Every
caller listed by `rg resolvePlacement` moves to `resolveAgent`/`resolveAgentDir`, including the two channel
`shared-api.ts` files, whose send tools derive the state root from their working directory: that is now the agent
directory itself.

### 3.2 Working directory and pi's project scope

`AgentAssembly.workspace` goes; `cwd` everywhere is `agentDir`: `assembleFront`, `agentModels(..., { cwd })`,
`readMachine(agentDir)`, `piAllCodingTools(agentDir)`, `session-builder.ts` (chat's `rootCwd`). `readMachine` keeps
reading pi's user scope and the project scope, which is now the agent directory; its project-scope skills and
prompts that lie **inside** the agent directory are dropped from the machine's half, because the definition loads
them itself (§3.4), and those above it stay as machine environment.

### 3.3 Prompt (`create.ts`, `agent-session-factory.ts`)

Landed in stage 1; [core](core.md) §2 describes it. What remains is stage 2's: `agentsFilesOverride` returns each
context's root `AGENTS.md` instead of the workspace walk, and FastAgent's sections gain the contexts section. The
"changing itself" section is rewritten for the new rules in stage 5 (§3.8, §3.9).

### 3.4 Definition loading (`definition.ts`)

Landed in stage 1 for the agent directory ([where the definition's files are
read](../configuration.md#where-the-definitions-files-are-read)), with `LoadedDefinition` keeping `contextFiles` until stage 2. What remains is stage 2's: `contextFiles`
goes, and each context's `.pi/skills/` and `.agents/skills/` load after the definition's, renamed
`<context>/<skill>` after loading.

### 3.5 Authored tools (`tool.ts`, `tool-context.ts`)

`ToolContext` gains `contexts: readonly ResolvedContext[]`; `cwd` is the agent directory. `TurnContext` carries
the list, set where the turn binds. `fastagent tool` passes the same resolved list.

### 3.6 Config and `fastagent context` (`config.ts`, new `cli/commands/context.ts`)

`FastagentConfig.contexts?: ContextDeclaration[]`, added to the known keys and validated by `declare.ts`.
`fastagent context add/remove` edits the source text the way `rewriteConfigModel` does for `model`: it locates the
literal `contexts: [ … ]` block `init` writes and regenerates it from the new list. The candidate is written to a
temporary file beside the config, under a name that is not a code input, imported, and compared with the list it
meant to write; only a match is renamed over `fastagent.config.ts`. A refusal therefore leaves the config, and any
serving process watching it, untouched. A missing block is created at the top of `export default {`; a computed
value, or an import that differs, refuses with the reason. `list --json` is
the resolved view (`ResolvedContext[]`) for clients.

### 3.7 Deploy (`deploy/`)

Today the build context is the workspace and the image bakes it at `/app` with the agent under a prefix. New layout:

```text
/app/definition/          the agent directory, minus .state/ and .secrets/
/app/contexts/<name>/     each local context declared with copy
```

`deploy` stages that tree in a build directory it owns (`.state/deploy/build/`), because a copied context lives
outside the agent directory and no host's build context can reach it.

- **One exclusion rule.** The stage is copied with the rules the generated ignore file carries today
  (`DOCKERIGNORE_BASE` in `container.ts`: `node_modules`, `.secrets/`, `.state`, `.cache`, `.env`, `.env.*`, logs,
  plus the resolved machinery paths), from one list both use. `build-context.ts`'s check that a kept ignore file
  does not let credentials through applies to what lands in the stage, so `deploy/build-context.ts` is part of this
  change.
- **Artifacts stay where they are.** The user-owned artifacts (`Dockerfile`, `fly.toml`, compose file, kept unless
  `--force`) are read in place; only the build context points at the stage. So the compose file's
  `env_file: .secrets/.env` keeps resolving next to it. Each host's way to name a separate build context
  (compose `build.context`, the directory argument of `fly deploy` and `railway up`, `docker build`'s context for
  AgentCore) is verified when stage 4 is built.
- The Dockerfile loses `ENV FASTAGENT_AGENT` and the agent prefix. It installs `git` when the staged tree carries a
  `.git` (today's `shipsGit` rule in `preflight.ts`) or any context is `github`.

On the host, `prepareStartWorkspace` and `applyDeploymentRelease` (`deploy/workspace.ts`) change from "seed the
workspace once, then replace `base/<agent>`" to:

- the definition: replaced from the image on every release, as `base/<agent>` is today, so a hosted agent's own
  harness changes last until the next release (distribution, per the model);
- each copied context: seeded by `materializeContexts` from `/app/contexts/<name>` into `.state/contexts/<name>`
  when absent (writable) or on every release (read-only), with the decision written to the log;
- each `github` context: cloned by `materializeContexts`, with `GITHUB_TOKEN` from the host's secrets.

Preflight (`deploy/preflight.ts`) prints one line per context from the same `declare.ts` data, refuses a `local`
context without `copy` and a context naming `path`, and on AgentCore states that every context is fetched again on
each deployment. `deploy/secrets.ts` lists `GITHUB_TOKEN` when any context is `github`.

### 3.8 Restart when idle (`dev-supervisor.ts`, `start`)

`dev-supervisor.ts` becomes the supervisor for `start` too (in a container it is PID 1's child). On a change to a
code input (the §6 list in the model, now including `.pi/settings.json` and `models-store.json`):

1. **Check.** Run the serving path's own load in a child process: one function, `checkServable(agentDir)`,
   which the serve also opens with, so "loads" has one meaning. It resolves the agent, then applies every refusal a
   serve applies before it binds: `refuseBrokenDeclarations` and `gateSecrets` for tools (`open.ts`), for channels
   (`service.ts`, `channels/discover.ts`) and for routines (`service.ts`). `info` is not used: it is built to
   finish despite those faults and exits 0 on them. If the check fails, keep the worker, log the error, and send
   it to the worker over IPC; the worker puts it into the "changing itself" section of the next turn's prompt.
2. **Drain.** Tell the worker to stop starting turns, through every way one starts:
   - `POST /invoke` and `POST /run` answer `503` with `Retry-After`;
   - a chat channel's durable turn store keeps what arrives, and a restart replays it;
   - the scheduler stops claiming (`startSchedules`' `stop`), so no routine or wake-up starts; a slot that comes due
     meanwhile is caught up by the next process, as after any restart;
   - on AgentCore, `/invocations` answers `503` and `/ping` reports `HealthyBusy`; whether the forwarder's caller (a
     webhook platform, EventBridge) retries is the host's retry policy, verified when stage 5 is built.

   Then wait until nothing runs: the session lease (`inProcessLease`) holds every session with a turn or compaction
   in flight, and `channels/busy.ts` counts channel and AgentCore work that has not reached the agent yet. With
   every way in closed, that count only falls. A ceiling still bounds the wait, after which the restart proceeds
   and says which turns it cut.
3. **Restart** the worker.

Each process serving the instance runs its own supervisor, so a change made in one process's turn restarts every
process once it is idle.

### 3.9 Routines (`schedule/discover.ts`, `schedule/cron.ts`)

A routine's cron is refused at discovery when it can fire twice less than `MIN_RECURRING_GAP_MS` (10 minutes,
shared with `wakeups.ts`) apart. The check looks only at the seconds, minutes and hours: it rewrites the
day-of-month, month and day-of-week fields to `*` and measures the gaps across one day and the wrap into the next.
So the answer depends on the definition alone, never on the date a process starts: a routine that passes today
passes every day, and one whose fires bunch only on some dates is refused every day, which errs on the safe side.
`cron.ts` gains the helper; the error names `POST /run` from an external scheduler as the way to fire more often.

### 3.10 `init` and the scaffold

`init <dir> [--context <source>]...` creates the agent in `<dir>` (new or empty). `--agent-dir` goes. Templates:
`persona.md` becomes `APPEND_SYSTEM.md` (standing instructions only, no "You are"), `.env.example` loses the
`FASTAGENT_AGENT` note. `--context` goes through the same code as `fastagent context add`: a checkout whose `origin`
is on GitHub becomes `{ github, local }`, any other directory `{ local, copy: true }`, `github:owner/repo` stays
remote; paths absolute; nesting refused with the command that puts the agent beside the project.

## 4. Decisions

| Question | Chosen | Not chosen, and why |
|---|---|---|
| When contexts are resolved | Once per process start; content re-read per turn | Per turn: network and git on every turn, for declarations that only change with a restart anyway |
| How a copied context reaches a host | Baked into the image from a staged build directory | Uploaded after deploy through each host's shell: four mechanisms, and AgentCore has none that persists |
| How FastAgent's sections enter the prompt | Named sections on `before_agent_start` | `APPEND_SYSTEM.md`'s slot: the author's file and ours would share one addendum, and `SYSTEM.md` users would lose nothing of theirs but would need ours re-added by hand |
| How a process restarts onto a new definition | A supervisor checks the load in a child, drains, restarts | In-process reload: built and removed in #600 for twelve limits |
| How `fastagent context` edits a TypeScript file | Rewrite the literal block, re-import, compare | A TypeScript parser: `typescript` is a dev dependency only, and the round-trip check gives the same safety for the one shape `init` writes |

## 5. Stages

Each stage is one PR, green on `npm run lint && npm run typecheck && npm test`, with the user docs it changes. No
release is cut between stage 2 and stage 4: in between, `deploy` refuses an agent with contexts, by name.

| Stage | Scope | Done when |
|---|---|---|
| 1. Prompt and resources (landed) | §3.3 and §3.4, except where `AGENTS.md` comes from and context skills; §3.5 `promptSnippet`; `init` scaffolds `APPEND_SYSTEM.md`. Placement unchanged: `agentsFilesOverride` returns today's `contextFiles` (the workspace walk), which `LoadedDefinition` keeps until stage 2 | The served prompt is pi's default plus FastAgent's sections, with the same `AGENTS.md` as before; `SYSTEM.md`, `APPEND_SYSTEM.md`, `prompts/`, the three skill locations and every refusal and report above have tests; `persona.md` is refused |
| 2. Agent directory and local contexts | §2 for `local` and `copy`, §3.1, §3.2, §3.3 and §3.4 for `AGENTS.md` and context skills, §3.5, §3.6, §3.10, and the part of §3.7 that locates the agent: the image holds the definition at `/app/definition`, `applyDeploymentRelease` replaces only the definition, and the deployed `start` opens it without `FASTAGENT_AGENT` | `resolvePlacement` is gone; every command takes `[agent]`; contexts are in the prompt, `AGENTS.md`, skills and `ToolContext`; an agent without contexts still deploys to every host; `deploy` refuses an agent with contexts, by name |
| 3. GitHub contexts | §2 clone and checkout rules, credentials | Clones, read-only refresh, `ref` notices and checkout detection are tested against a local bare repository standing in for GitHub |
| 4. Deploy with contexts | The rest of §3.7: the staged build directory, copied and `github` contexts on a host, `GITHUB_TOKEN` | Every host deploys an agent with each context type; preflight prints each fate; AgentCore says what it resets |
| 5. Self-change runtime | §3.8, §3.9; `core.md` §2 and the "changing itself" section | `dev` and `start` restart only when idle and only onto a definition that loads; a too-frequent routine is refused |

## 6. Tests worth naming

- **One resolution.** A test that changes a declaration and asserts the prompt section, `ToolContext.contexts`,
  `info --json` and `context list --json` all change together, so a second derivation cannot creep in.
- **Nesting and names.** Each refusal in `declare.ts` once, in `contexts-declare.test.ts`; callers test only their
  wiring, per the repository's rule for shared rules.
- **No machine prompt.** A machine `~/.pi/agent/SYSTEM.md` in a temporary `PI_CODING_AGENT_DIR` does not reach the
  prompt; run with the override removed to watch the test fail.
- **Drain.** A turn in flight when a tool file changes finishes, then the worker restarts; with the drain removed,
  the test sees the turn cut.
- **Config edit round trip.** `context add` on a hand-edited computed `contexts` refuses, and leaves the file
  untouched.
- **One meaning of "loads".** A tool file that throws on import, and a tool that declares a secret with no value,
  each fail `checkServable`, so the supervisor keeps the old worker; with the check swapped for `info`, the test
  watches the restart happen.
- **Materializing.** Two processes starting on a missing clone produce one clone; `info` on that agent creates
  nothing.

## 7. Public surface that changes

`CreatePiAgentFromDirOptions` and `createPiAgentFromDir`'s result lose `workspace` and gain `contexts`;
`LoadedDefinition` loses `persona` and `contextFiles`; `ToolContext` gains `contexts`, and its `cwd` changes meaning
from the project to the agent directory with no type change, so an authored tool that reads project files through
`cwd` moves to `contexts` (the release notes say so); `CreatePiAgentFromDefinitionOptions.cwd`
means the agent directory; `FASTAGENT_AGENT` and `init --agent-dir` are removed; `[dir]` becomes `[agent]`. duang
calls `createPiAgentFromDir` and stores an agent's directory, so it needs the same change in step with stage 2.

## 8. Open

- **The drain ceiling.** How long a supervisor waits for running turns before it restarts anyway. A long turn and a
  stuck one look alike; the first number should come from turn durations in practice.
- **The cron floor errs strict.** Ignoring the day fields refuses a cron whose fires bunch only on some dates.
  Enforcing the floor when a slot is claimed would allow those, at the cost of a routine that starts and then
  silently skips fires; not worth it before such a cron shows up.
- **Git as a dependency.** Stage 3 needs `git` on the author's machine, and stage 4 in the image. Both are already
  the norm for this audience; the refusal names it when it is missing.
