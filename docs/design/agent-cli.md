---
title: Agent CLI
description: "How the CLI addresses an Agent, where a local instance lives, what init declares, how content is edited, and what each command shows about it. The command-line side of the agent model."
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
- **All content is resolved out loud, in the author's words.** What the agent works on and what it knows,
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
└── content/                         where the instance reaches each content entry: a link, or its clone
```

Runtime state is not part of the definition ([agent model](agent-model.md) §5). That says what it belongs to, not
which directory holds it. Keeping it beside the definition means moving the directory moves its conversations,
an agent needs no name on its own machine, and there is nothing to list or clean up but the directory itself.
Terraform keeps its local state in `.terraform/` beside the configuration for the same reasons. Since an agent
directory is never inside its content, this state never sits in a project's tree.

What this asks of others: both directories stay out of version control (the ignore files `init` writes keep them out), and a tool that copies an
Agent to give it to someone leaves them out. duang's design already excludes `.secrets`, `.env` and session state
from a preset.

Considered: a registry of instances under `~/.fastagent/instances/<name>/`. The definition directory would hold
only the definition, but every instance would need a name, `ls` and `rm` commands would be needed, and moving an
agent directory would separate it from its conversations.

A hosted instance keeps its state in the host's storage; how is a deployment question.

## 3. `init`

```bash
fastagent init <dir> [--content <source>]...
```

`init` creates the agent in `<dir>` itself, which must be new or empty, and adds one content entry it works on per
`--content`. Without `--content` the agent has none and only talks. Content it only knows is added afterwards
with `fastagent content add --readonly`.

| `<source>` | Declared in `context.json` | `content/<name>` |
|---|---|---|
| The root of a checkout whose remote is on GitHub | `{ "github": "owner/repo" }` | A link to the checkout |
| Any other directory, a subdirectory of such a checkout included | `{}`; for a subdirectory, a note names the `github:` form, which is the whole repository | A link to the directory |
| `github:owner/repo` | `{ "github": "owner/repo" }` | A clone, made when the agent starts |

- **No path is declared; a link is written absolute.** The declaration is shared with the definition and a path
  describes one machine, so the path lives only in the link, and an absolute link keeps meaning the same directory
  when the agent directory moves.
- **A directory is never widened to its repository.** A subdirectory of a checkout is declared as itself, so an
  agent kept in that checkout can still work on one directory of it; the note says how to declare the repository.
- **Content may not contain the agent, or sit inside it.** `init ~/code/app/agent --content ~/code/app` is
  refused, with the way out: put the agent beside the project, `init ~/agents/reviewer --content ~/code/app`.
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

## 4. Editing content: `fastagent content`

People edit `context.json` by hand, and so can a client such as duang: it is JSON. Content belongs in the
definition, not in the client, or a deployment from that directory would lose it. The links are this machine's, and
`content add` makes the one an entry needs here. Both use one implementation: the command, or the API under it
(`createAgent`, `addContent`, `removeContent`, `listContent` in `/pi`; [API reference](../api-reference.md#content)).
The command:

```bash
fastagent content list [agent] [--json]
fastagent content add <source> [agent] [--readonly] [--name <n>] [--ref <r>] [--description <text>]
fastagent content remove <name> [agent]
```

- `<source>` is read as in `init`: a directory, or `github:owner/repo`. `--readonly` makes it content the agent
  knows rather than works on.
- `add` refuses a directory that contains the agent directory or sits inside it, and asks for `--name` when the
  default name is already taken (ignoring case) or is not one segment of letters, digits, `-` and `_`.
- `remove` drops the entry and its link. A clone at `content/<name>` is left, and said to be: it may hold the
  agent's work.
- An edit is checked against the content it would leave before anything is written: while another entry does not
  resolve (its link points to a directory that moved), `add` and `remove` are refused with that entry's error.
  Removing the broken entry itself always works.
- `list` groups them the way an author thinks: what the agent works on, what it knows.
- On another machine, an entry the agent already declares is linked by hand (`ln -s <dir> content/<name>`, after
  `mkdir -p content` and with any clone there moved away; [configuration](../configuration.md#content)); a `github`
  entry with nothing linked is cloned.

## 5. Running: `dev`, `start`, `chat`, `invoke`

Startup says what the agent works on and what it knows:

```text
agent     ~/agents/reviewer  (model openai-codex/gpt-5.5)
works on  app       ~/code/app (github acme/app, this checkout)
knows     handbook  ~/agents/reviewer/content/handbook (github acme/handbook@main, a clone brought up to date at each start)
instance  ~/agents/reviewer/.state
```

What is said rather than handled quietly:

| Situation | Output |
|---|---|
| A `github` entry has nothing linked here | `github acme/app: cloned in …/content/app`, or `already up to date`; a warning when the clone has the agent's changes or GitHub cannot be reached |
| A link points to nothing, to a file, or (for a `github` entry) to anything but a checkout of that repository | Refused, naming the link and what it points to |
| A `local` entry has nothing linked here | Said; the agent is not told of it |
| A linked directory contains the agent directory or sits inside it | Refused, naming both and the way out |
| Two entries' names are equal ignoring case, or a name is not one segment of letters, digits, `-` and `_` | Refused, naming them |
| A linked checkout is not at the declared `ref` | Said, with both; the checkout is left as it is |
| A changed definition does not load when `dev` restarts on an edit | The worker exits with the reason, and the next save retries |
| The definition on disk does not load at a fresh start | Refused, with the error and the way back: revert the change with version control, or deploy again |
| A `github` entry cannot be reached for lack of a credential | Refused: on this machine git's own credentials, on a host a secret in its store |

## 6. `info`

`info` adds each content entry's resolution and what a deployment would do with it, so an author sees which entries
would not reach a host without deploying.

## 7. `deploy`

The definition is shipped to the host. Preflight lists what the host gets for each content entry:

```text
works on  app       github acme/app@main          cloned; brought up to date where git can without touching the agent's work
knows     handbook  github acme/handbook@main     cloned; kept up to date
works on  draft     a directory of this machine   stays here; the deployed agent works without it
          → to work on it from a host, move it to a GitHub repository (warning)
knows     papers    a directory of this machine   stays here; the deployed agent works without it
          → to ship what the agent reads there, copy it into the agent directory outside content/ (note)
```

- **A repository is a clone the instance makes and brings up to date in place at each start**, on a host as on
  this machine ([agent model](agent-model.md) §3). Where a deployment resets the host's storage (AgentCore), the
  clone goes with it, and preflight says what of the agent's work is lost.
- **A local directory does not reach a host, and the deploy goes ahead without it** ([agent model](agent-model.md)
  §3): preflight names it, a warning for one the agent works on, and the host's start names it again. The agent
  directory does reach a host, as the definition each release replaces.
- **A `github` entry's credential is `GITHUB_TOKEN` in `.secrets/.env`**, which travels with the other values;
  only a private repository, or an agent that pushes, needs it.

## 8. `login` and `add <channel>`

What they store goes to the local instance (`.secrets/`).
