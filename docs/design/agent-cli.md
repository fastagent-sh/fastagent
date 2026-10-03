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
- **Every context is resolved out loud.** Where each one came from, where it is, and what a host will get are
  printed, never inferred silently.

## 1. Addressing an Agent

Commands that take an agent take `[agent]`: the path to an agent directory, the one holding
`fastagent.config.ts`. Without it, the current directory decides:

| The current directory | Result |
|---|---|
| Is an agent | That agent |
| Is inside an agent directory (`~/agents/reviewer/skills/`) | Refused, naming the agent's root: `cd` there or pass it |
| Anything else | Refused: pass the agent's path, or create one with `fastagent init` |

Agents live in their own directories, not inside the projects they work on ([agent model](agent-model.md) §2), so
there is nothing to search for below the current directory. These go away:

- the one-level scan for agents inside a directory (`agentsAt`);
- `FASTAGENT_AGENT`, and the rule that a directory named `fastagent` wins a tie;
- the `ENV FASTAGENT_AGENT` a generated Dockerfile pins.

## 2. The local instance

On a machine, an agent directory has one instance. Its state stays where it is today:

```text
~/agents/reviewer/
├── persona.md  skills/  tools/  …   the definition
├── .secrets/                        the instance's credentials
└── .state/                          the instance's sessions, channel and schedule state
    └── workspace/                   the instance's own files; also where a github context is cloned
                                     when no checkout is named
```

Runtime state is not part of the definition ([agent model](agent-model.md) §5). That says what it belongs to, not
which directory holds it. Keeping it beside the definition means moving the directory moves its conversations,
an agent needs no name on its own machine, and there is nothing to list or clean up but the directory itself.
Terraform keeps its local state in `.terraform/` beside the configuration for the same reasons. Since an agent
directory is never inside a context, this state never sits in a project's tree.

What this asks of others: both directories stay out of version control (they do today), and a tool that copies an
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

`init` creates the agent in `<dir>` itself, which must be new or empty, and declares one context per `--context`,
in order. The first is the primary context. Without `--context` the agent has none and only talks.

| `<source>` | Declared |
|---|---|
| A directory in a checkout whose remote is on GitHub | `{ github: "owner/repo", local: "<checkout root>" }`, plus `path` when the directory is below the root |
| Any other directory | `{ local: "<directory>", copy: true }` |
| `github:owner/repo` | `{ github: "owner/repo" }` |

- **Paths are written absolute.** They describe this machine, and an absolute path keeps meaning the same
  directory when the agent directory moves.
- **`copy: true` keeps today's deployment** for a directory that is not on GitHub: a deploy today seeds the host
  with the directory once and leaves the host's copy alone afterwards, which is what a writable copied context
  means.
- **A context may not contain the agent, or sit inside it.** `init ~/code/app/agent --context ~/code/app` is
  refused, with the way out: put the agent beside the project, `init ~/agents/reviewer --context ~/code/app`.
- **Run in a project, `init` says where to go.** `fastagent init .` in a directory that is not empty is refused
  with the command that creates the agent elsewhere and attaches this directory.

Example output:

```text
created ~/agents/reviewer
context  app  github acme/app, using the checkout ~/code/app; a host clones it
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

- `<source>` is read as in `init`: a directory, or `github:owner/repo`.
- `add` appends; `--primary` puts the context first, making it the working directory.
- `add` refuses a context that contains the agent directory or sits inside it.
- The command edits only the literal `contexts` array `init` writes. When an author has replaced it with a
  computed value, the command refuses and says why, rather than guessing.

## 5. Running: `dev`, `start`, `chat`, `invoke`

Startup prints how every context resolved:

```text
agent     ~/agents/reviewer  (model openai-codex/gpt-5.5)
context   app    github acme/app → ~/code/app (existing checkout)   working directory
context   notes  local ~/notes, copied on deploy
instance  ~/agents/reviewer/.state
```

What is said rather than handled quietly:

| Situation | Output |
|---|---|
| A `github` context's `local` path is missing, or is not a checkout of that repository | `cloning acme/app into .state/workspace/app`, with the reason |
| A local context's path does not exist | Refused, naming the path and the declaration |
| A context contains the agent directory or sits inside it | Refused, naming both and the way out |
| A `github` context cannot be reached for lack of a credential | Refused: on this machine git's own credentials, on a host a secret in its store |

## 6. `info`

`info` adds each context's resolution and what a deployment would do with it, so an author learns that a deploy
would be refused without trying one.

## 7. `deploy`

The definition is shipped to the host. Preflight lists what the host gets for each context:

```text
context  app    github acme/app@main   cloned on the host
context  notes  local ~/notes          copied once, when the instance is created
context  draft  local ~/draft          refused: not available on a host
         → add `copy: true`, or move it to a GitHub repository and declare it as github
```

- **A later deploy leaves existing clones and writable copies as they are,** and says so. They are the instance's
  own; bringing them up to date is synchronization ([agent model](agent-model.md) §8).
- **A `github` context's credential is a host secret.** The runbook lists it with the instance's other secrets.

## 8. `login` and `add <channel>`

Unchanged as commands. What they store goes to the local instance (`.secrets/`), as it does today.

## 9. What changes from today

| Today | In this design |
|---|---|
| `[dir]` is a workspace or an agent directory, found by a one-level scan | `[agent]` is an agent directory: the current one, or a path |
| `FASTAGENT_AGENT` and a `fastagent`-named tie-break select among several agents | A path selects one |
| The Dockerfile pins `ENV FASTAGENT_AGENT` | Nothing to pin |
| `init [dir]` creates `./fastagent/` inside a project, and the project becomes its workspace | `init <dir>` creates the agent in its own directory; `--context` attaches what it works on |
| An agent lives inside its project | An agent and its contexts never contain one another |
| Contexts do not exist | `fastagent context list/add/remove` |
| Startup reports the workspace | Startup reports each context's resolution |
| `deploy` copies the workspace once and replaces the definition on later deploys | `deploy` ships the definition, shows each context's fate, refuses a local context without `copy`, and leaves existing clones and copies alone |
