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
declaration whose meaning depends on where the instance runs: a local path, a checkout, a clone. The hard part is to compute that answer **once per process, in one function, and have every consumer read
the same value**: the prompt, the coding tools' working directory, skills, authored tools, `info`, `deploy`
preflight and the startup report. Two derivations of it would disagree, the way the run and observation planes
once did.

Everything else in this note is plumbing around that value or a separate, smaller change (the prompt, the
restart, the routine floor).

## 2. The resolved agent

Built in stages 2 and 3; [core](core.md) §2 describes it: `src/contexts/` declares (`declare.ts`, pure), resolves
(`resolve.ts`: the disk and git, never the network, no writes) and clones (`cloneContext`, called by the opener
only). `ResolvedContext` carries `name`, `readonly`, `location` and `notices`, and for a `github` context its `repo`,
`ref` and whether it is a clone. A repository is its user's checkout when `local` names one, used as it is;
otherwise it is a clone, shallow, at `ref`, brought up to date in place at each start of a process that runs the
agent by git's own rules, which never overwrite the agent's work (what git refuses keeps it as it is). Read-only commands (`info`, `context list`, `fastagent tool`, the
restart check of §3.8) resolve without cloning, so they never touch the network, and `info` keeps its contract of
creating nothing.

Both columns are built:

| Declaration | `local` | `host` |
|---|---|---|
| `local` | The path; refused if missing or not a directory | Refused (preflight already refused the deploy) |
| `github` with a usable `local` | The checkout; a notice when it is not at `ref` | A clone in `.state/contexts/<name>` |
| `github` without one | A clone in `.state/contexts/<name>` | Same |

A `local` context does not reach a host (agent model §3), so a host resolves `github` contexts only.

**When it runs.** Resolution once per process start, before the assembly; cloning once per start of a process that
runs the agent, before resolution. Fetching per turn would put network and git on every turn. What is re-read per
turn is the content at the resolved locations (`AGENTS.md`, skills), as the definition is re-read today. A changed
declaration is a config change, so it restarts the process (§3.8).

## 3. Change by area

### 3.1–3.6 Addressing, working directory, prompt, definition loading, authored tools, `fastagent context`

Landed in stage 2; [core](core.md) §2, [configuration](../configuration.md#contexts) and the
[CLI reference](../cli.md#fastagent-context) describe them. Choices made there that this plan left open:

- **Sources.** `init --context` and `context add` declare a directory as `{ local }`, the root of a GitHub checkout
  as `{ github, local }`, and `github:owner/repo` as `{ github }`; `--ref` and `--local` arrived with GitHub
  contexts (stage 3), on `context add`.
- **The candidate config is `.fastagent.config.next.ts`** beside the real one: a dotfile `dev` does not watch, removed
  whether or not it replaces the config.

### 3.7 Deploy (`deploy/`)

Landed in stages 2 and 4. A release ships the definition and nothing else: the agent directory is the build context,
baked at `/app/definition`, with every artifact at its root, and the storage holds `definition/` beside `.state/`
and `.secrets/` (storage laid out with `base/` is refused). Contexts reach a host only by their type: a `github` one
is cloned there by the same `cloneContext` as on a laptop, the author's `local` not looked for, with `GITHUB_TOKEN`
from the host's environment through the credential helper in each clone's config; the image installs `git` for it.
A `local` one is refused by preflight, naming each, with the two ways out (agent model §3): what the agent only
reads goes in the agent directory, what it works on moves to a repository. Preflight prints what each context
becomes on the host, says on AgentCore that every clone starts over on each deployment, and notes a missing
`GITHUB_TOKEN`, which a public repository does not need. [core](core.md) §2 and §9 describe it.

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

Landed in stage 2 ([CLI reference](../cli.md#fastagent-init)), with every directory declared `{ local }`.
Stage 3 makes a checkout whose `origin` is on GitHub `{ github, local }`, and `github:owner/repo` a remote context.

## 4. Decisions

| Question | Chosen | Not chosen, and why |
|---|---|---|
| When contexts are resolved | Once per process start; content re-read per turn | Per turn: network and git on every turn, for declarations that only change with a restart anyway |
| Whether a local directory reaches a host | No: a context reaches a host only by a type whose home the host reaches (a repository today), and the agent directory reaches it as the harness, replaced by each release | A copy baked into the image (`copy: true`, built through stage 3 and removed before it deployed): each instance's copy became data of its own, which nothing brought back together, so it was not the same data anywhere (agent model §3); it tied the data to the release cadence and image size, put local data in the image registry, and needed a staged build directory and a different build context on every host. What it served splits: reference material the agent only reads ships in the agent directory; data it works on needs a home, a repository today and further context types later |
| How FastAgent's sections enter the prompt | Named sections on `before_agent_start` | `APPEND_SYSTEM.md`'s slot: the author's file and ours would share one addendum, and `SYSTEM.md` users would lose nothing of theirs but would need ours re-added by hand |
| How a process restarts onto a new definition | A supervisor checks the load in a child, drains, restarts | In-process reload: built and removed in #600 for twelve limits |
| How `fastagent context` edits a TypeScript file | Rewrite the literal block, re-import, compare | A TypeScript parser: `typescript` is a dev dependency only, and the round-trip check gives the same safety for the one shape `init` writes |
| Where an agent's work goes, apart from its definition | A context it works on, as the prompt directs; the working directory stays the agent's own directory | A context declared `workdir` (#716; built in #719, closed). It differs from a writable context in two defaults. Where commands start: [agent model](agent-model.md) §4 measured `cd <location> && …` against an agent whose working directory is the project, three models, 180 runs, no difference. Where a file created without a path lands: the prompt tells the agent a result worth keeping belongs in a context it works on; not measured, judged enough for current models. Against both, it would separate pi's one cwd (project settings, session directory, extension cache, settings file) from the agent directory in every reader. Reopen with a measurement of results landing in the definition |

## 5. Stages

Each stage is one PR, green on `npm run lint && npm run typecheck && npm test`, with the user docs it changes. No
release is cut between stage 2 and stage 4: in between, `deploy` refuses an agent with contexts, by name.

| Stage | Scope | Done when |
|---|---|---|
| 1. Prompt and resources (landed) | §3.3 and §3.4, except where `AGENTS.md` comes from and context skills; §3.5 `promptSnippet`; `init` scaffolds `APPEND_SYSTEM.md`. Placement unchanged: `agentsFilesOverride` returns today's `contextFiles` (the workspace walk), which `LoadedDefinition` keeps until stage 2 | The served prompt is pi's default plus FastAgent's sections, with the same `AGENTS.md` as before; `SYSTEM.md`, `APPEND_SYSTEM.md`, `prompts/`, the three skill locations and every refusal and report above have tests; `persona.md` is refused |
| 2. Agent directory and local contexts (landed) | §2 for `local` and `copy`, §3.1, §3.2, §3.3 and §3.4 for `AGENTS.md` and context skills, §3.5, §3.6, §3.10, and the part of §3.7 that locates the agent: the image holds the definition at `/app/definition`, `applyDeploymentRelease` replaces only the definition, and the deployed `start` opens it without `FASTAGENT_AGENT` | `resolvePlacement` is gone; every command takes `[agent]`; contexts are in the prompt, `AGENTS.md`, skills and `ToolContext`; an agent without contexts still deploys to every host; `deploy` refuses an agent with contexts, by name |
| 3. GitHub contexts (landed) | §2 for `github` on this machine: a checkout used as it is, otherwise a clone brought up to date in place at each start; git's own credentials; `github:` sources, `--ref`, `--local` | Clones, `ref` notices and checkout detection are tested against a local bare repository standing in for GitHub |
| 4. `github` contexts on a host (landed) | §3.7 for `github`: a clone on the host by the same `cloneContext`, the author's `local` not looked for; `GITHUB_TOKEN` through a credential helper in the clone's config; `git` in the image; preflight prints each context's fate and refuses directory ones | An agent whose contexts are all `github` deploys to every host; AgentCore says what it resets |
| Removing `copy` | `copy: true`, `--copy` and their reports, now that no host receives a copy (decision above) | A declaration with `copy` is refused at load, naming the two ways out |
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
- **Cloning.** An update in place never overwrites the agent's work (git refuses, and the clone is kept with the
  reason); a file written while another process updates the clone stays; `info` on an agent with a clone not made
  yet creates nothing.

## 7. Public surface that changes

As of stage 2: `createPiAgentFromDir`, `createAgentService` and `mountAgentService` take the agent directory itself
and lose `workspace`; `createPiAgentFromDir` gains `contexts`; `LoadedDefinition` lost `persona` (stage 1) and its
`contextFiles` now hold each context's `AGENTS.md`; `ToolContext` gains `contexts`, and its `cwd` changes meaning from
the project to the agent directory with no type change, so an authored tool that reads project files through `cwd`
moves to `contexts` (the release notes say so); `CreatePiAgentFromDefinitionOptions.cwd` is removed (the agent
directory is the working directory) and `contexts` added; `resolveContexts` and its types are exported from `/node`;
`FASTAGENT_AGENT` and `init --agent-dir` are removed; `[dir]` becomes `[agent]`. duang calls `createPiAgentFromDir`
and stores an agent's directory, so it needs the same change before the next release. Stage 3: `ResolvedContext` is
a union (a `github` one adds `repo`, `ref`, `clone`) and gains `notices`; `cloneContext` is exported from `/node`.

## 8. Open

- **The drain ceiling.** How long a supervisor waits for running turns before it restarts anyway. A long turn and a
  stuck one look alike; the first number should come from turn durations in practice.
- **The cron floor errs strict.** Ignoring the day fields refuses a cron whose fires bunch only on some dates.
  Enforcing the floor when a slot is claimed would allow those, at the cost of a routine that starts and then
  silently skips fires; not worth it before such a cron shows up.
- **Git as a dependency.** Stage 4 needs `git` in the image, as stage 3 needs it on the author's machine, where a
  missing one is refused by name.
