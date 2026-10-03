---
title: Agent CLI
description: "How the CLI addresses an Agent, where a local instance lives, what init declares, how contexts are edited, and what each command shows about them. The command-line side of the agent model."
type: design-doc
status: proposed
---

# Agent CLI

**Status: proposed.** The command-line side of the [agent model](agent-model.md): what an author types and what
they see. Tracking issue: [#684](https://github.com/fastagent-sh/fastagent/issues/684).

Three rules shape every command:

- **A command names an Agent by its directory.** Nothing about what the agent works on is derived from where
  that directory sits.
- **The local instance is implicit.** An author runs an agent; they do not create or name an instance on their
  own machine.
- **Every context is resolved out loud.** Where each one came from, where it is, and what a host will get
  are printed, never inferred silently.

## 1. Addressing an Agent

Commands that take an agent take `[agent]`: the path to an agent directory, the one holding
`fastagent.config.ts`. Without it, the current directory decides:

| The current directory | Result |
|---|---|
| Is an agent | That agent |
| Is inside an agent directory (`app/fastagent/skills/`) | Refused, naming the agent's root: `cd` there or pass it |
| Holds exactly one agent directly inside it | That agent, so `cd app && fastagent dev` keeps working |
| Holds several | Refused, listing them: name one, `fastagent dev pm` |
| Holds none | Refused: run `fastagent init` |

`pm` in `fastagent dev pm` is a path, `./pm`. Selecting an agent needs nothing else, so these go away:

- `FASTAGENT_AGENT`, and the rule that a directory named `fastagent` wins a tie;
- the `ENV FASTAGENT_AGENT` a generated Dockerfile pins;
- "an agent directory used as its own project is not supported": declare `contexts: [{ local: "." }]` on this
  machine. On a host such an agent needs a `github` context, because a copy of it would leave the agent directory
  out and be empty ([agent model](agent-model.md) §3).

## 2. The local instance

On a machine, an agent directory has one instance. Its state stays where it is today:

```text
app/fastagent/
├── persona.md  skills/  tools/  …   the definition
├── .secrets/                        the instance's credentials
└── .state/                          the instance's sessions, channel and schedule state
    └── workspace/                   the instance's own files; also where a github context is cloned
                                     when no checkout is named
```

Runtime state is not part of the definition ([agent model](agent-model.md) §5). That says what it belongs to, not
which directory holds it. Keeping it beside the definition means moving the directory moves its conversations,
an agent needs no name on its own machine, and there is nothing to list or clean up but the directory itself.
Terraform keeps its local state in `.terraform/` beside the configuration for the same reasons.

What this asks of others: both directories stay out of version control (they do today), and a tool that copies an
Agent to give it to someone leaves them out. duang's design already excludes `.secrets`, `.env` and session state
from a preset.

The cost: in the default layout the agent directory is inside its primary context, so these files sit inside the
tree the agent works in. They never travel with the context, but an agent with a shell can open them, and so can
a second agent working on the same project. That is true of any file its account can read, so placing them
elsewhere on the machine would not change it ([agent model](agent-model.md) §5).

Considered: a registry of instances under `~/.fastagent/instances/<name>/`. The definition directory would hold
only the definition, but every instance would need a name, `ls` and `rm` commands would be needed, and moving an
agent directory would separate it from its conversations. It would not keep the state from an agent's shell
either.

A hosted instance keeps its state in the host's storage; how is a deployment question.

## 3. What `init` declares

`init` writes the `contexts` declaration for where it was run, and prints what it wrote and what it means.

| Where `init` runs | Declared |
|---|---|
| A git repository whose remote is on GitHub | `[{ github: "owner/repo", local: "<path to the repository root>" }]`, plus `path` when `init` ran in a subdirectory |
| A git repository with another remote, or none | `[{ local: "..", copy: true }]` |
| Not a git repository | `[{ local: "..", copy: true }]` |
| Any of these, with `--no-context` | `[]`: an agent that only talks |

- **`copy: true` keeps today's deployment.** A deploy today seeds the host with the directory once and leaves the
  host's copy alone afterwards. A writable copied context means exactly that.
- **A subdirectory stays the working directory.** `init` in `repo/packages/x/` declares
  `{ github: "acme/repo", local: "../../..", path: "packages/x" }`, so the agent works in `packages/x` as it
  does today.

Example output:

```text
created app/fastagent
context  app  github acme/app, using this checkout here; a host clones it
```

## 4. Editing contexts: `fastagent context`

People edit `fastagent.config.ts` by hand. A client such as duang cannot safely rewrite a TypeScript module, and
contexts belong in the definition, not in the client, or a deployment from that directory would lose them. Both
use one command:

```bash
fastagent context list [agent] [--json]
fastagent context add <source> [agent] [--name <n>] [--copy] [--ref <r>] [--path <p>] [--local <dir>] [--primary]
fastagent context remove <name> [agent]
```

- `<source>` is a directory for a local context, or `github:owner/repo`.
- `add` appends; `--primary` puts the context first, making it the working directory.
- The command edits only the literal `contexts` array `init` writes. When an author has replaced it with a
  computed value, the command refuses and says why, rather than guessing.

## 5. Running: `dev`, `start`, `chat`, `invoke`

Startup prints how every context resolved:

```text
agent     app/fastagent  (model openai-codex/gpt-5.5)
context   app    github acme/app → ~/code/app (existing checkout)   working directory
context   notes  local ~/notes, copied on deploy
instance  app/fastagent/.state
```

What is said rather than handled quietly:

| Situation | Output |
|---|---|
| A `github` context's `local` path is missing, or is not a checkout of that repository | `cloning acme/app into .state/workspace/app`, with the reason |
| A local context's path does not exist | Refused, naming the path and the declaration |
| A `github` context cannot be reached for lack of a credential | Refused: on this machine git's own credentials, on a host a secret in its store |

## 6. `info`

`info` adds each context's resolution and what a deployment would do with it, so an author learns that a deploy
would be refused without trying one.

## 7. `deploy`

Preflight lists what the host gets for each context:

```text
context  app    github acme/app@main   cloned on the host; the harness runs from it
context  notes  local ~/notes          copied once, when the instance is created
context  draft  local ~/draft          refused: not available on a host
         → add `copy: true`, or move it to a GitHub repository and declare it as github
```

- **A harness committed in a `github` context deploys what is at the context's `ref`.** Deploy compares the agent
  directory with the head of that `ref` on the remote, and refuses when they differ: uncommitted changes, commits
  not pushed, or work pushed to another branch than the one the host will clone. The author almost certainly
  expects their version to run. The refusal names the ways out: push to that `ref`, or pass `--allow-unpushed` to
  run the `ref`'s head knowingly.
- **A later deploy updates the host's clone only when nothing is lost.** It fast-forwards the clone to the
  `ref`'s head when the clone holds no changes of the instance's own, and otherwise refuses, saying what the
  instance changed ([agent model](agent-model.md) §3).
- **A `github` context's credential is a host secret.** The runbook lists it with the instance's other secrets.

## 8. `login` and `add <channel>`

Unchanged as commands. What they store goes to the local instance (`.secrets/`), as it does today.

## 9. What changes from today

| Today | In this design |
|---|---|
| `[dir]` is a workspace or an agent directory | `[agent]` is an agent directory, or the one directly inside the current directory |
| `FASTAGENT_AGENT` and a `fastagent`-named tie-break select among several agents | A path selects one; several without a path is refused with the list |
| The Dockerfile pins `ENV FASTAGENT_AGENT` | Nothing to pin |
| An agent directory cannot be its own project | `contexts: [{ local: "." }]` on this machine; a `github` context on a host |
| `init` writes no context; the parent directory becomes the workspace | `init` declares the context it was run in, and says so |
| Contexts do not exist | `fastagent context list/add/remove` |
| Startup reports the workspace | Startup reports each context's resolution |
| `deploy` copies the workspace once | `deploy` shows each context's fate, refuses a local context without `copy`, refuses a harness that differs from its `ref`, and updates a clone only by fast-forward |
