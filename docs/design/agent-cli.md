---
title: Agent CLI
description: "How the CLI addresses an Agent, where a local instance lives, what init declares, how contexts are edited, and what each command shows about them. The command-line side of the agent model."
type: design-doc
status: implemented
---

# Agent CLI

**Status: implemented.** The command-line side of the [agent model](agent-model.md): what an author types and what
they see. Tracking issue: [#684](https://github.com/fastagent-sh/fastagent/issues/684).

Three rules shape every command:

- **A command names an Agent by its directory.** Nothing about what the agent works on is derived from where
  that directory sits.
- **The local instance is implicit.** An author runs an agent; they do not create or name an instance on their
  own machine.
- **Every context is resolved out loud, in the author's words.** What the agent works on and what it knows,
  where each one is, and what a host will get are printed, never inferred silently.

## 1. Addressing an Agent

Commands that take an agent take `[agent]`: the path to an agent directory, the one holding
`fastagent.config.ts`. Without it, the current directory decides:

| The current directory | Result |
|---|---|
| Is an agent | That agent |
| Is inside an agent directory (`~/agents/reviewer/skills/`) | Refused, naming the agent's root: `cd` there or pass it |
| Anything else | Refused: pass the agent's path, or create one with `fastagent init` |

Agents live in their own directories, not inside the projects they work on ([agent model](agent-model.md) §2), so
there is nothing to search for below the current directory: no scan for agents inside a directory, and no
environment variable that chooses among several; a generated Dockerfile names the one directory it ships.

## 2. The local instance

On a machine, an agent directory has one instance. `dev`, `start` and a one-off `invoke` run in that directory
are processes serving the same instance. Its state is kept beside the definition:

```text
~/agents/reviewer/                   the working directory
├── APPEND_SYSTEM.md  skills/  …     the definition
├── .secrets/                        the instance's credentials
├── .state/                          the instance's sessions, channel and schedule state
└── .contexts/                       the clones the instance made, under each context's name
```

Runtime state is not part of the definition ([agent model](agent-model.md) §5). That says what it belongs to, not
which directory holds it. Keeping it beside the definition means moving the directory moves its conversations,
an agent needs no name on its own machine, and there is nothing to list or clean up but the directory itself.
Terraform keeps its local state in `.terraform/` beside the configuration for the same reasons. Since an agent
directory is never inside a context, this state never sits in a project's tree.

What this asks of others: both directories stay out of version control (the ignore files `init` writes keep them out), and a tool that copies an
Agent to give it to someone leaves them out. duang's design already excludes `.secrets`, `.env` and session state
from a preset.

Considered: a registry of instances under `~/.fastagent/instances/<name>/`. The definition directory would hold
only the definition, but every instance would need a name, `ls` and `rm` commands would be needed, and moving an
agent directory would separate it from its conversations.

A hosted instance keeps its state in the host's storage; how is a deployment question.

## 3. `init`

```bash
fastagent init <dir> [--context <source>]...
```

`init` creates the agent in `<dir>` itself, which must be new or empty, and adds one context it works on per
`--context`. Without `--context` the agent has none and only talks. A context it only knows is added afterwards
with `fastagent context add --readonly`.

| `<source>` | Declared |
|---|---|
| The root of a checkout whose remote is on GitHub | `{ github: "owner/repo", local: "<checkout root>" }` |
| Any other directory, a subdirectory of such a checkout included | `{ local: "<directory>" }`; for a subdirectory, a note names the `github:` form, which is the whole repository |
| `github:owner/repo` | `{ github: "owner/repo" }` |

- **Paths are written absolute.** They describe this machine, and an absolute path keeps meaning the same
  directory when the agent directory moves.
- **A directory is never widened to its repository.** A subdirectory of a checkout is declared as itself, so an
  agent kept in that checkout can still work on one directory of it; the note says how to declare the repository.
- **A context may not contain the agent, or sit inside it.** `init ~/code/app/agent --context ~/code/app` is
  refused, with the way out: put the agent beside the project, `init ~/agents/reviewer --context ~/code/app`.
- **Run in a project, `init` says where to go.** `fastagent init .` in a directory that is not empty is refused
  with the command that creates the agent elsewhere and attaches this directory.
- **The agent is a git repository from the start.** `init` runs `git init` and commits the scaffold, so a change the
  agent makes to itself can be reviewed and undone ([agent model](agent-model.md) §6). Inside an existing repository
  that tracks it, it does not; without git, or without a commit identity, it says so.

`init` scaffolds `APPEND_SYSTEM.md` for the agent's standing instructions, so a
new agent keeps pi's default prompt and follows it as pi improves it. An agent that should be someone other than
pi's coding assistant replaces the default with `SYSTEM.md` instead ([agent model](agent-model.md) §2). An agent
directory that still has a `persona.md` is refused rather than served with an identity it ignores; the refusal
names both files and when to use each.

Example output:

```text
created  ~/agents/reviewer
works on app  ~/code/app (github acme/app); a host clones it
```

## 4. Editing contexts: `fastagent context`

People edit `fastagent.config.ts` by hand. A client such as duang cannot safely rewrite a TypeScript module, and
contexts belong in the definition, not in the client, or a deployment from that directory would lose them. Both
use one implementation: the command, or the API under it (`createAgent`, `addContext`, `removeContext`,
`listContexts` in `/pi`; [API reference](../api-reference.md#contexts)). The command:

```bash
fastagent context list [agent] [--json]
fastagent context add <source> [agent] [--readonly] [--name <n>] [--ref <r>] [--local <dir>]
fastagent context remove <name> [agent]
```

- `<source>` is read as in `init`: a directory, or `github:owner/repo`. `--readonly` makes it a context the agent
  knows rather than works on.
- `add` refuses a context that contains the agent directory or sits inside it, and asks for `--name` when the
  default name is already taken (ignoring case) or is not one segment of letters, digits, `-` and `_`.
- `list` groups them the way an author thinks: what the agent works on, what it knows.
- The command edits only the literal `contexts` array `init` writes. When an author has replaced it with a
  computed value, the command refuses and says why, rather than guessing.

## 5. Running: `dev`, `start`, `chat`, `invoke`

Startup says what the agent works on and what it knows:

```text
agent     ~/agents/reviewer  (model openai-codex/gpt-5.5)
works on  app       ~/code/app (github acme/app, this checkout)
knows     handbook  ~/agents/reviewer/.contexts/handbook (github acme/handbook@main, a clone brought up to date at each start)
instance  ~/agents/reviewer/.state
```

What is said rather than handled quietly:

| Situation | Output |
|---|---|
| A `github` context has no checkout here | `cloned github acme/app into .contexts/app`, or `github acme/app is up to date in the clone in …`; a warning when the clone has the agent's changes or GitHub cannot be reached; when its `local` path is missing or is not a checkout of that repository, the reason too |
| A local context's path does not exist | Refused, naming the path and the declaration |
| A context contains the agent directory or sits inside it | Refused, naming both and the way out |
| Two contexts' names are equal ignoring case, or a name is not one segment of letters, digits, `-` and `_` | Refused, naming them |
| A `local` checkout is not at the declared `ref` | Said, with both; the checkout is left as it is |
| A changed definition does not load when `dev` restarts on an edit | The worker exits with the reason, and the next save retries |
| The definition on disk does not load at a fresh start | Refused, with the error and the way back: revert the change with version control, or deploy again |
| A `github` context cannot be reached for lack of a credential | Refused: on this machine git's own credentials, on a host a secret in its store |

## 6. `info`

`info` adds each context's resolution and what a deployment would do with it, so an author sees which contexts would
not reach a host without deploying.

## 7. `deploy`

The definition is shipped to the host. Preflight lists what the host gets for each context:

```text
works on  app       github acme/app@main          cloned; brought up to date where git can without touching the agent's work
knows     handbook  github acme/handbook@main     cloned; kept up to date
works on  draft     local ~/draft                 stays on this machine; the deployed agent works without it
          → to work on it from a host, move it to a GitHub repository (warning)
knows     papers    local ~/papers                stays on this machine; the deployed agent works without it
          → to ship what the agent reads there, copy it into the agent directory (note)
```

- **A repository is a clone the instance makes and brings up to date in place at each start**, on a host as on
  this machine ([agent model](agent-model.md) §3). Where a deployment resets the host's storage (AgentCore), the
  clone goes with it, and preflight says what of the agent's work is lost.
- **A local directory does not reach a host, and the deploy goes ahead without it** ([agent model](agent-model.md)
  §3): preflight names it, a warning for one the agent works on, and the host's start names it again. The agent
  directory does reach a host, as the harness each release replaces.
- **A `github` context's credential is `GITHUB_TOKEN` in `.secrets/.env`**, which travels with the other values;
  only a private repository, or an agent that pushes, needs it.

## 8. `login` and `add <channel>`

What they store goes to the local instance (`.secrets/`).
