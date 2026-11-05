---
title: The agent framework's artifact and instance inputs
description: "FastAgent as an agent framework: one immutable built definition, assembled deterministically from explicit instance inputs (configuration, secrets, state, workspace) on a laptop, inside an app or in the cloud."
type: design-doc
status: constraints and direction decided; not implemented
---

# The agent framework's artifact and instance inputs

**Status: constraints and direction decided; not implemented.** Tracking: [#900](https://github.com/fastagent-sh/fastagent/issues/900).
This revises the first draft merged in [#901](https://github.com/fastagent-sh/fastagent/pull/901). FastAgent 0.29.0 still
opens a writable author directory; nothing below describes current runtime behavior. Items marked *implementation
research* are decided in direction and settled while building.

## 1. What this is for

FastAgent is a framework for building agent services, in the way FastAPI, Flask or Next.js are frameworks for web
services. Its core guarantee:

> **One definition, developed locally, imported into an app, or deployed to a cloud host, assembles into the same agent.
> The assembly changes only with explicit inputs (configuration, secrets, state). Environmental differences that cannot
> be removed are declared and visible.**

The guarantee is about **assembly determinism**, not model output. The same artifact with the same explicit inputs gives
the same:

- model-facing text: system prompt, `AGENTS.md`, the skill and prompt-template lists and their text;
- capabilities: tools, MCP servers, extensions, channels, schedules;
- configuration: effective model, thinking level and settings, each with its source;
- paths and environment: declared paths resolve to the same absolute locations relative to the instance roots, and the
  same commands and variables are required and passed to child processes (§5);
- failure semantics: a missing input refuses the open at the same point, the same way.

Acceptance:

1. One artifact, opened locally and on a host, reports the same assembly in `fastagent info --json`, except for the
   explicit inputs.
2. A cloud failure is reproduced locally by what differs: the artifact runs under the cloud's inputs on this machine
   (`fastagent build`, then `fastagent start`, which reads the production value file, with the configuration and an empty root), and on
   the cloud's machine (`fastagent deploy docker --run` runs the deployment's image here). Differences between this
   machine's architecture and the host's are not reproduced (§8).
3. An implicit dependency (a machine file, a shell variable, the author checkout) fails at preflight or open, not first
   in the cloud.

**The deployment unit is the author's project**, as for a web application. Embedding is a goal: an app imports an
agent's npm package and opens instances of it. A workbench app such as Kage is that case: it bundles a program and
each agent its user creates is an instance of it (§4.6). Opening a source project is `fastagent dev`'s alone; an app
opens built definitions. A general product for running anyone's published package is not a first-slice goal.

### 1.1 Web-framework correspondence

| Web framework | FastAgent |
|---|---|
| Application code (routes, views) | The definition: `SYSTEM.md`, skills, prompts, tools, channels, schedules |
| Framework runtime | FastAgent on pi-durable |
| Server contract (WSGI/ASGI) and servers | `openAgent()` and the [Agent API](../SPEC.md); the host adapters |
| Dev server with reload | `fastagent dev` |
| Build output (wheel, Next.js `standalone`) | `dist/`, an npm package |
| Typed settings (pydantic-settings, Django/Rails settings) | `settings` schema and `defaults` in `fastagent.config.ts`; values in `fastagent.json` |
| Per-environment configuration | One instance `fastagent.json` per environment |
| Database, configured apart from the app server | State storage (sessions, grants, credentials) |
| Static and uploaded files | Packaged `assets/`; the instance workspace |
| Mounting a sub-application (Blueprint, `mount`) | `import` the agent package, `openAgent(definition, inputs)` |
| Deploy tooling (Kamal, Vercel) | `fastagent deploy` and its host adapters |

What differs from a web app: an agent needs a writable filesystem workspace for its coding tools, runs for minutes,
continues after interruption, and has side effects (shell, external APIs, git). That is why the workspace and state are
explicit inputs below rather than whatever the process happens to find.

## 2. Principles

1. **The program is immutable.** A built npm package exports a definition, not a live Agent (Route B). A running
   instance never writes into it.
2. **An instance is its inputs, not a directory convention.** The framework fixes which inputs an open accepts, their
   precedence, and where FastAgent writes. How a developer lays out files and what they commit is theirs.
3. **FastAgent writes only state.** An open (`openAgent`, `dev`, `start`, a deployment) never writes the package, the
   configuration it was given, or secret inputs. The agent's own tools are another matter: they act with the process's
   authority and may write any file they can reach, a configuration inside the workspace included (§4.2). The CLI's
   editing commands (`content add`, `env add`, `add <channel>`) are authoring and operating tools, not the running
   instance: each writes only the file it targets (§3.3, §4.2, §6.2).
4. **One file, one audience.** Program files are the author's; instance files are the deployer's.
5. **File rule.** Code and typed defaults are TypeScript; FastAgent data a command rewrites is JSON, one file per side;
   an ecosystem-standard format (MCP) keeps its own file.
6. Unchanged: one harness, instance-owned MCP clients, explicit shared grants, storage leases, unsafe replay and the
   [Agent API](../SPEC.md) semantics. Nothing here is a sandbox; the coding tools act with the process's authority.

## 3. The program

### 3.1 Source

```text
my-agent/
  package.json
  fastagent.config.ts      constants, defaults, settings schema, providers/extensions
  context.json             content baseline and environment requirements
  mcp.json                 default MCP servers; secrets as ${VAR} references (it is published)
  SYSTEM.md  AGENTS.md
  skills/  prompts/
  src/tools/ src/extensions/ src/channels/ src/schedules/
  src/lib/  assets/        optional
  test/  README.md
```

Code is registered by where it is. A small capability is one file (`src/tools/search.ts`); a larger one is a directory
with an `index.ts` entry and its helpers and resources beside it (`src/tools/search/index.ts`), never both under one
name. Only entries register; helpers and tests do not. Per-capability resources stay with their owner; `assets/` holds
definition-wide ones.

### 3.2 `fastagent.config.ts`

```ts
import { defineAgent } from "@fastagent-sh/fastagent";
import { obj, opt, str } from "@earendil-works/pi-schema";

export default defineAgent({
  // Constants: what this program is. An instance cannot change them.
  name: "reviewer",
  description: "Reviews pull requests",
  providers: [/* code; endpoints and keys parameterized with needs() */],
  extensions: [/* code */],

  // Settings the author lets each instance choose; non-secret values come from the instance.
  settings: obj({ repo: str(), digestChannel: opt(str()) }),

  // Defaults: the type of an instance's configuration. An instance may override any of them.
  defaults: {
    model: "openai/gpt-5.5",
    thinkingLevel: "high",
    http: { port: 8787, api: true },
    deploy: { agentcore: { idleTimeoutSeconds: 900 } },
    settings: { digestChannel: "#general" },
  },
});
```

- A field outside `defaults` is a constant. No separate ownership table is needed.
- `settings` uses [`@earendil-works/pi-schema`](https://www.npmjs.com/package/@earendil-works/pi-schema): plain JSON
  Schema with static types and no dependencies of its own, so it is added as a dependency of FastAgent whatever pi
  release is in use. It is the schema language pi-durable 1.5.0 uses for tool parameters, so tools and settings share
  one language once FastAgent moves to 1.5.0 ([#903](https://github.com/fastagent-sh/fastagent/issues/903)); the
  settings work does not wait for it. Secrets stay with `needs()` beside the code that reads them; `settings` is for
  non-secret values.
- `fastagent build` runs the configuration check, so a mistake fails before publication rather than at a host's open.
- A configuration without `settings` can stay a literal with a type-only import, as today's scaffold writes it, and
  opens before `npm install`. Declaring `settings` calls the schema builders at run time, so that configuration imports
  `@fastagent-sh/fastagent` and needs its dependencies installed; the scaffold starts literal and the author switches to
  `defineAgent` when adding settings.

### 3.3 `context.json` and `mcp.json`

`context.json` keeps its current shape: `content`, the baseline sources the agent works on, and `environment`, the
commands, runtimes and variable names it needs. Its name matches the vocabulary in
[agent-model.md](agent-model.md): context is content, connectors and environment; connectors are `mcp.json`.
`fastagent env add` rewrites its `environment` (the environment belongs only to the program).
`fastagent content add --program` rewrites its `content` baseline; without `--program`, `content add` writes the
instance configuration instead (§4.2). Both edits keep the existing lock. `context.local.json` is gone: a machine's
own directories belong to the instance's configuration.

`mcp.json` is the default MCP servers in the standard `mcpServers` shape. It is published with the package, so its
secrets are `${VAR}` references (§4.1).

Language dependencies stay in `package.json`. Names already declared by `needs()` or MCP references are aggregated, not
registered again.

### 3.4 The build output

```text
dist/
  package.json             generated publication metadata and exports
  index.js  index.d.ts     generated definition entry
  bin.js                   generated executable (package.json `bin`): runs the same start as `fastagent start`
  fastagent.config.js
  fastagent.schema.json    generated JSON Schema for an instance's fastagent.json
  context.json  mcp.json
  SYSTEM.md  AGENTS.md  skills/  prompts/
  src/                     compiled JavaScript and the files it needs
  assets/
  LICENSE                  when applicable
```

`dist/` is complete and self-contained: nothing at run time reads the author checkout. It holds no instance
configuration, secrets, clones, tests or build-machine paths. Node refuses type stripping under `node_modules`, so the
module graph is JavaScript. Relative relationships between resources are preserved; the build does not guess and
rewrite paths inside strings, skill scripts or MCP arguments.

CI gates: inspect the actual `npm pack` tarball (files rules are not secret protection), open the package from a
read-only filesystem, and run two instances side by side to prove isolation.

### 3.5 The exported definition

`import reviewer from "@acme/reviewer"` gives a **frozen, branded plain object**, generated by the build and never
written by hand:

```ts
// dist/index.js, generated
export default defineDefinition({
  format: 1,
  name: "reviewer",
  version: "1.2.0",
  root: new URL(".", import.meta.url),
  config,                                    // constants, defaults, settings schema
  modules: { tools, extensions, channels, schedules },
});
```

- Its public type promises only `name`, `version`, the settings schema and the **declared inputs**: each secret name
  with what it is for, whether it is optional and where it is declared (`needs()`, MCP references, `context.json`'s
  environment, the default model's provider), and the commands the environment requires. A host shows what an instance still needs from this list
  rather than parsing files; deploy's missing-value report uses the same list. Other fields are internal and may change
  between releases. A symbol brand lets `openAgent` recognize a built definition.
- It is typed by its settings (`AgentDefinition<Settings>`), so the compiler checks the keys and types of an
  embedder's `settings` input; the open checks the merged settings against the schema, refusing a missing required one.
- It is customized only through `openAgent(definition, inputs)`, never by mutation, which keeps the assembly
  deterministic.
- An agent package declares as peers (and dev dependencies) `@fastagent-sh/fastagent` and the pi packages its code
  imports, `@earendil-works/pi-durable`, `@earendil-works/pi-ai` and `@earendil-works/pi-schema`, in the ranges FastAgent publishes for its own
  release (`src/version.ts`), so an app holds one copy of each. FastAgent does not re-export pi's authoring API: an
  author's tools, extensions and providers are pi code, imported from pi's packages ([architecture.md](architecture.md)
  §2). Only FastAgent's own authoring surface (`defineAgent`, `needs()`, `defineSchedule`) comes from
  `@fastagent-sh/fastagent`; the settings builders are `@earendil-works/pi-schema`'s.
- `format` is an integer independent of the framework's semver; `openAgent` refuses an incompatible one and names the
  version it needs. The peer range governs installation; `format` governs what opens.

## 4. The instance

### 4.1 Inputs

An instance is four inputs:

| Input | Holds | FastAgent |
|---|---|---|
| **Configuration** | `fastagent.json` and `.mcp.json`, or the same schema as an API object | Reads only |
| **Secrets** | Values for the names `needs()`, MCP `${VAR}` references and `context.json`'s environment declare, and the model provider's variables | Reads only; held in memory, never written |
| **State** | Sessions, model credentials, MCP grants, model lists, channel state | Writes |
| **Workspace** | The agent's working directory: acquired content and what the agent produces | The agent writes; may be disposable |

The workspace and state share one **instance root** by default, laid out as coding agents lay out a project, with the
framework's own data in a hidden directory:

```text
<root>/                 the workspace: the agent's cwd
  .state/               sessions, auth.json, MCP grants, model lists, channel state
  content/<name>/       acquired content (clones)
  ...                   what the agent produces
```

State inside the agent's cwd is no new exposure (the agent can already reach its state; nothing here is a sandbox), but
a careless `rm` or `git add -A` can touch it; `.state/` belongs in an ignore file. `--state` moves it elsewhere, for
example onto a block volume while the workspace sits on a network filesystem.

Every input can be placed anywhere, so a host can mount each on the storage that suits it:

| Input | Flag | Environment variable | `openAgent` option |
|---|---|---|---|
| Instance configuration | `--config <file>` | `FASTAGENT_CONFIG` | `config` (an object, or the absolute path of a `fastagent.json`) |
| MCP server declarations | `--mcp-config <file>` | `FASTAGENT_MCP_CONFIG` | `mcpServers` (an object, or an absolute path; default `.mcp.json` beside a `config` path) |
| MCP authorization (OAuth grant store, bindings, transport) | — | — | `mcp` |
| Secrets | `--env-file <file>` | the process environment | `secrets` (`Record<string, string>`) |
| Child-process base environment (§5) | — | the CLI's own `PATH`, `HOME`, locale, proxy variables | `env` |
| Instance name (§4.5) | `--name <name>` | `FASTAGENT_NAME` | `name` |
| Instance root | `--root <dir>` | `FASTAGENT_ROOT` (replaces `FASTAGENT_STORAGE_DIR`) | `root` |
| State, apart from the root | `--state <dir>` | `FASTAGENT_STATE_DIR` | `stateDir` |
| Workspace, apart from the root | `--workdir <dir>` | `FASTAGENT_WORKDIR` | `workdir` |

Default locations:

| Where | Configuration | Instance root |
|---|---|---|
| `fastagent dev` in a project | `fastagent.json` and `.mcp.json` at the project root, when present | `.fastagent/dev/` |
| `fastagent start` and `npm start` in a project (opens the project's `dist/`) | Only what `--config` or `FASTAGENT_CONFIG` names; otherwise the program's defaults | `.fastagent/start/` in the project |
| The package's `bin` (`npx @acme/reviewer`) | Only what `--config` or `FASTAGENT_CONFIG` names; otherwise the program's defaults | None: `--root` or `FASTAGENT_ROOT` is required |
| Docker, Fly, Railway | `/etc/fastagent/`, what `deploy --config` delivers in the image; otherwise the program's defaults | `/data/`, the volume |
| AgentCore | `/etc/fastagent/`, what `deploy --config` delivers in the image; otherwise the program's defaults | `/mnt/data/`, SessionStorage, reset on every deploy |
| Embedding | The `config` object; otherwise the program's defaults | None: `root`, or `stateDir` and `workdir`, are required |

`<name>` is the instance name (§4.5). A host's instance root is `/data` (AgentCore's SessionStorage must mount at
exactly `/mnt/<one level>`, so there it is `/mnt/data`), named to the runtime through `FASTAGENT_ROOT`; §6.1 says why
it carries no name. `start`
never reads the development `fastagent.json`: production inputs are explicit. In a project, `start` opens the
built `dist/`, never the source (§1): it refuses, naming `fastagent build`, when `dist/` is missing or was built from
other sources than the project now holds (the build records a fingerprint of what it read). It does not build on its
own; the scaffold's `start` script is `fastagent build && fastagent start`. A project-relative default is anchored to
the project the command opens (the directory holding its `fastagent.config.ts`), as `dev`'s is; outside a project there
is nothing to anchor to. The package's `bin` and embedding therefore have no default root, because the only candidate,
the process's cwd, would be an implicit input: running `npx @acme/reviewer` from two directories must not open two
instances.

- For the CLI, a flag beats its environment variable, which beats the default. Relative paths resolve once at the
  command's entry, against the directory it was started in.
- `.mcp.json` defaults to the instance configuration's directory, so one mounted directory (a Kubernetes ConfigMap, a
  read-only volume) carries both files; `--mcp-config` separates them.
- `openAgent` reads only its options, never these environment variables and never `process.env` for secret values: an
  embedding app that wants them reads and passes them itself (`secrets: process.env` is an explicit choice).
  `secrets` is distinct from `credentials`, the model providers' credential store (sign-ins and stored API keys),
  which today's `openAgent` already takes. A model provider's environment variable (`ANTHROPIC_API_KEY`, or a name a
  definition's `providers` read) is a secret: the model's auth reads it from the `secrets` input, the CLI's included,
  and never from `process.env` (today `modelsOver` falls back to `process.env`; that changes). The declared inputs
  list the names the default model's provider reads, optional because a stored credential satisfies them too; they
  reach the model's auth only, not child processes (§5). An implicit read would let a stray shell variable open a
  different instance, breaking assembly determinism. (Today `openAgent` falls back to `FASTAGENT_STATE_DIR`; that changes.)
- External data the agent works on needs no separate root: it is a `path` entry under `content`, and clones live in the
  workspace.
- `FASTAGENT_AUTH_PATH` remains a finer override of where the model credentials file lives; its default is
  `<state>/auth.json`. `FASTAGENT_SECRETS_DIR` and the `.secrets/` directory are no longer part of an instance: secrets
  are an in-memory input (`--env-file`, the environment, `secrets`), and the two files that lived there, the model
  credentials and the MCP grants, move under `.state/`. `.secrets/.env` remains only `dev`'s default env file (§4.3).

Storage each input tolerates:

| Input | Suitable storage | Why |
|---|---|---|
| Configuration | Read-only: a ConfigMap, a read-only volume, a derived image | FastAgent only reads it |
| State | A block volume (local disk, EBS, a Fly volume) | The storage and its lease rely on file locking and `fsync`; network filesystems (NFS, EFS) are risky and object-store mounts unusable. *Implementation research:* test on EFS/NFS, then refuse or warn |
| Workspace | A block volume, or a network filesystem | Works on both, but git and many small files are slow over a network; an object-store mount is unsuitable for a git workspace |
| `content` `path` entries | Any mount, read-only included | Data the agent reads and writes |

Precedence of configuration values, lowest first:

1. framework defaults;
2. the program's `defaults`;
3. the instance configuration;
4. environment variables: secrets and a few overrides such as `FASTAGENT_MODEL`;
5. command-line flags and `openAgent` options.

Composition:

- Settings override by key: objects merge recursively, arrays replace.
- Content and MCP entries only add. An instance entry whose name collides with a program entry is refused; nothing is
  shadowed, deep-merged or written back into the program files.
- Skills and prompt templates are namespaced instead of refused. A program's have a full name `<program>-<name>`
  (`reviewer-review`), built from the program name normalized to one segment (§4.5); an instance's are bare, since an
  instance is what opens. A full name obeys the rule of its kind, which differs. A skill name is lowercase letters,
  digits and single hyphens, at most 64 characters (the Agent Skills rule, enforced where skills are read), so
  `/skill:reviewer-review` needs no special syntax and the open refuses a program name and skill name whose join breaks
  the rule. A prompt template's name is its file name, and the only constraint is that it contains no whitespace,
  because a message's `/<name>` is matched up to the first whitespace; existing names such as `Review_PR` stay valid, and
  the join is refused only if it would contain whitespace, which a normalized program name cannot add. A program's bare
  name is an alias while no instance entry takes it.
  When one does, the bare name is the instance's, the program's stays listed and invocable by its full name, and the
  open reports the overlap. A program upgrade that adds a name an instance already uses therefore never stops the
  instance from opening. One program's full names never collide with each other, since its bare names are distinct.
  An instance's bare name can equal a program entry's full name (an instance `reviewer-review` beside a program
  `review`). Then the instance's entry takes that name and the program's entry is not invocable; the open reports it
  as shadowed, naming both files, and `info` lists it, so the drop is visible (§7) and an upgrade still opens.

- An instance layers only on the program's defaults, never on another instance.

**MCP: three different things.** A server's declaration (`command` or `url`, `args`, headers with `${VAR}`
references) is configuration: the program's `mcp.json` declares the servers every instance connects, an instance's
`.mcp.json` or `mcpServers` adds its own. The values those references name are secrets, the same input `needs()` reads; today's `McpOptions.variables` merges into `secrets`. An OAuth grant, created
when a person authorizes in a browser and refreshed afterwards, is state. `mcp` keeps `store`, `bindings` and `fetch`
([mcp-auth.md](mcp-auth.md)). A program-declared server without its required value or grant refuses the open and says
what is missing.

OAuth tokens never enter an MCP file, as in every client using this format: they live in the grant store below. A
static credential is different: the format allows a literal value in `headers` or `env`, and FastAgent accepts one, so
an entry copied from a server's documentation works as it is. A file that travels should carry `${VAR}` references
instead, with the value supplied as `secrets`. FastAgent cannot tell whether a string is a secret, so it warns and
never refuses, and only where the file travels because of FastAgent:

- `fastagent build` warns about a literal in the program's `mcp.json` `headers` or `env`, which is published;
- `fastagent deploy` warns the same for an instance `.mcp.json` it bakes into an image or delivers to a host;
- a workbench app warns the same when it exports an instance folder (Kage's "give someone the agent").

An instance file that stays on its machine is its owner's choice and draws no warning.

Where a static value lives depends on where the instance runs; it reaches the instance only as the `secrets` input:

| Where | The value lives in | It reaches the instance through |
|---|---|---|
| `fastagent dev` | the project's `.secrets/.env`, never committed | the default env file |
| `fastagent start`, the package's `bin` | an operator's owner-only file outside the configuration directory, or the process environment | `--env-file <path>` or the environment |
| Docker | `.secrets/production/.env` on the machine running Compose, owner-only | Compose `env_file:`, §6.2 |
| Fly, Railway | the platform's secrets | the platform's injected environment |
| AgentCore | one JSON secret in Secrets Manager | its ARN in the environment, read at start |
| An embedding app (Kage) | the app's own secure store (the macOS Keychain) | `openAgent({ secrets })` |

A grant and its binding are written by the sign-in flow, not supplied by a person:

| Part | What it is | Where |
|---|---|---|
| Grant | Access and refresh tokens | The grant store: `<root>/.state/` by default, owner-readable and never exported; or a host's own (`mcpGrantFile(path)` in an app's private directory) |
| Binding | Which grant this instance's server uses | `<root>/.state/` by default; an app may keep bindings in its own records and pass `mcp.bindings` |

A grant is created where the instance runs. Locally, `fastagent mcp login <server>` or the host's UI opens the browser.
A deployed instance authorizes for itself and is never given a copy of a local or Kage grant, since two holders of one
grant log each other out when either refreshes. Today that means running the login against the deployment with its
callback port forwarded to the browser's machine; an automatic relay is a known gap (§8). A server that needs no OAuth
uses static values instead. (0.29.0 keeps grants in `.secrets/mcp-auth.json` and bindings in the state root's
`mcp-bindings.json`; with `.secrets/` no longer part of an instance, grants move under `.state/` beside the model
credentials' `auth.json`.)

### 4.2 `fastagent.json` and `.mcp.json`

```json
{
  "$schema": "./node_modules/@acme/reviewer/fastagent.schema.json",
  "model": "anthropic/claude-x",
  "http": { "port": 9000 },
  "deploy": { "agentcore": { "idleTimeoutSeconds": 300 } },
  "settings": { "repo": "acme/api" },
  "content": {
    "handbook": { "github": "acme/handbook", "ref": "main" },
    "data": { "path": "/srv/data" }
  },
  "instructions": ["./AGENTS.md"],
  "skills": ["./skills"],
  "prompts": ["./prompts"]
}
```

`fastagent.json` holds every FastAgent-owned instance input: overrides of the program's defaults, settings values,
additional content sources (repositories, and directories of this machine, which `context.local.json` held before), and the
instance's own instructions, skills and prompt templates. `instructions` names files added after the program's text;
`skills` and `prompts` name directories. All are relative to `fastagent.json`, and only what is declared loads: a file
the agent writes elsewhere in its workspace never becomes a capability. Where the configuration directory is the
writable instance root (a local instance, §4.6), the person and the agent can add to these directories, taking effect
at the next open (§7); deployed, they ship in the read-only configuration (`/etc/fastagent/skills/`). A directory that
resolves to, or inside, text the program loads (its `SYSTEM.md`, `AGENTS.md`, `skills/` or `prompts/`), and an
`instructions` file that is one of them, is a configuration error reported at open: it would load the program's text
twice. Other paths are allowed wherever they are. In a development project the program is the source project, so the
root's `AGENTS.md`, `skills/` and `prompts/` are the program's and the example above is refused there; a development
instance declares paths of its own, such as `./dev/AGENTS.md` and `./dev/skills`, which the build does not package
(§3.4). The example is an instance configuration directory of its own (a deployment's `/etc/fastagent/`, a Kage folder, §4.6). `content add` writes this file by default: the
development instance's at the project root, or the one `--config <file>` names; `--program` targets the program's `context.json` instead (§3.3). `.mcp.json` stays a file of its own because it is the ecosystem's format: entries copy from any
server's documentation, and Claude Code working in the same directory reads the same servers, which is intended.

`fastagent.json` holds no secret values; secrets are referenced by name. `.mcp.json` follows the rule for MCP files in
§4.1.

### 4.3 Development defaults

In a project, `fastagent dev` defaults its inputs so a new agent needs no flags: configuration and `.mcp.json` from the
project root when present, secrets from `.secrets/.env`, and the instance root `.fastagent/dev/` (§4.1). The
workspace is kept apart from the source, so `dev` runs the same shape as a deployment. At the root, the program's
`mcp.json` (packaged defaults) and the development instance's `.mcp.json` (additions, read by Claude Code too) sit side
by side; the names and §4.1's composition rule keep them distinct. Other environments are other inputs, given
explicitly. How a team lays out per-environment files, what it commits and whether it keeps a personal local layer is
the developer's choice; the framework adds no local layer.

`.fastagent/dev/` sits inside the author's repository, where git run in the workspace would otherwise find and act on
the author's repository, while on a host there is no repository above `/data/`. The child environment (§5)
therefore sets `GIT_CEILING_DIRECTORIES` to the workspace's parent (the agent's cwd's) for every instance, so git
discovery stops at the workspace everywhere, wherever `--workdir` or `workdir` puts it and whether or not a root is given, and an agent cannot commit the author's source by walking upward.

`dev` loads the definition through the same assembly as a deployment. It has no mode that imitates the cloud: running
on this machine, it can reproduce neither the host's machine nor a layout the host does not have yet, and what it could
imitate, `start` already runs (§1, acceptance 2).

In development the instance configuration sits at the project root and the agent's cwd is `.fastagent/dev/`, so the
agent's tools reach the configuration only by absolute path; nothing steers them there, and an agent that does edit it
is acceptable for the reason in §4.2 (one trust domain, effective at the next open, visible in version control). A
local instance whose configuration directory is its instance root (§4.6) is where an agent adds its own skills in
ordinary use. Deployed configuration is read-only (§6.1). A local host watches the declared configuration (§7) and
reopens after the current turns finish, so an edit lands without a manual restart.

Running follows the npm and web-framework conventions, three entries over one start:

- `fastagent start` is the framework's runner, like `next start` or `uvicorn`;
- the scaffold writes `package.json` scripts `dev`, `build` and `start`, so `npm start` works in a project;
- the build writes a `bin` into `dist/`, so a published agent runs as `npx @acme/reviewer --config … --root …`, and a
  container's entry is `node /app/dist/bin.js` without resolving a CLI.

A single-file executable (Bun `--compile`, Node SEA) is deferred: the skills and text it would have to embed are read by
relative path.

### 4.4 Embedding

```ts
import reviewer from "@acme/reviewer";

const agent = await openAgent(reviewer, {
  config: { model: "anthropic/claude-x", settings: { repo: "acme/api" }, content: { /* … */ } },
  root: "/var/lib/myapp/reviewer",
  secrets: { GITHUB_TOKEN: vault.read("github") },   // values for needs() and MCP references
  mcp: { bindings: { linear: grantId } },            // which OAuth grant each server uses
  credentials,                                       // model providers' credential store
});
```

The app needs no files: configuration is the same schema as an object, read by the same resolver the CLI uses for
`fastagent.json`; an app that keeps its instances as folders passes the file's path instead (§4.6). Two opens share nothing their inputs do not name: no cwd, relative output, binding or default (two given one
`workdir` share that workspace, which is the caller's to avoid).

### 4.5 Identity

An instance's name is an explicit input (`--name`, `FASTAGENT_NAME`, `name`; §4.1). It defaults to the definition's
name, normalized to one path segment (`@scope/pkg` is not one), because a deployment joins it onto storage and
resource names; two instances of one definition on one machine take distinct names. `info().name` reports it.

### 4.6 A workbench app: Kage

Kage, a desktop workbench, bundles a program and opens one instance of it per agent its user creates. Writing
TypeScript tools stays with `fastagent dev`; what a Kage user changes (instructions, skills, prompts, MCP servers,
folders, model, settings) is the instance layer. An instance there is one visible folder, the same shape as a deployed
one:

```text
~/Agents/<slug>/            instance root = workspace, writable
  fastagent.json  .mcp.json  AGENTS.md  skills/  prompts/
  .state/                   sessions, MCP grants (not exported)
  ...                       what the agent produces
```

- Kage passes `root`, `name`, `config` as the path of the folder's `fastagent.json` (so its relative entries resolve
  against the folder, and the model choice and folder bindings Kage records there are what the person and the agent
  see), `secrets` from its own store, `env` with its proxy, `credentials` and `mcp` bindings. No secret value is written
  into the folder.
- `GIT_CEILING_DIRECTORIES` is `~/Agents`, so a person can keep each agent in git of its own.
- Giving someone the agent copies the folder without `.state/`; the recipient opens it with the same program.
- Kage watches the declared files and reopens after current turns, as `dev` does.
- When Kage ships a newer program, names an instance already uses stay the instance's (§4.1).

## 5. Paths

**Resolve once, where a declaration is read, into an absolute path with its origin** (program or instance, which file).
Everything downstream sees only absolute paths, so no subsystem picks its own base.

- A relative path is relative to the declaration file containing it. A path given through the API must be absolute; a
  relative one is refused rather than resolved against the process's cwd.
- A module's packaged resource is relative to the module (`import.meta.url`); a skill's resource to the skill's root;
  a coding tool's relative path to the workspace.
- MCP: a command containing a path resolves against its declaration file; a bare command uses the child environment's
  `PATH`; `args` pass verbatim, since FastAgent cannot know which strings are paths; the child's working directory is
  the declaration file's directory. A packaged stdio server therefore starts in the read-only package; one that needs a
  writable directory is given one explicitly.
- A stdio server given through the API (`openAgent({ mcpServers })`) has no declaration file: it must carry an absolute `cwd`,
  and a command containing a path must be absolute. Otherwise the open is refused; nothing falls back to the process's
  cwd.
- No `process.chdir()` and no `process.env` mutation select an instance.

**The child environment.** Every process the instance starts (the shell tool, stdio MCP servers, skill scripts) gets
an environment assembled from inputs, never the host process's whole `process.env`:

1. a base: `PATH`, `HOME`, `USER`, `SHELL`, `LANG`, `LC_*`, `TZ`, `TMPDIR` and the proxy variables (`HTTP_PROXY`,
   `HTTPS_PROXY`, `NO_PROXY`). The CLI copies these from its own environment; `openAgent` takes them from its `env`
   option, and an embedding app that wants its own passes them (`env: baseEnv(process.env)`, a helper FastAgent exports);
2. the commands of `context.json`'s environment, ahead of the base's `PATH`;
3. the secrets the definition declares (`needs()`, `context.json`'s environment) that the `secrets` input supplies;
   undeclared names are not passed on;
4. an MCP entry's own `env` for that server;
5. `GIT_CEILING_DIRECTORIES` set to the workspace's parent (§4.3).

So a stray variable in the host's shell cannot reach a command, and a declared variable reaches every one. The base
list is part of the assembly that `info` reports.

## 6. Cloud deployment

### 6.1 What goes where

`fastagent deploy <host>` derives a deployment from the project's artifact and the selected instance inputs:

| Part | Lifecycle | In the cloud |
|---|---|---|
| Program | Per version | The image, read-only |
| Configuration | Per deployment | Delivered with the deployment in the image, read-only: `/etc/fastagent/` |
| Secrets | Per deployment, rotatable | The platform's secret storage |
| State | Durable | `/data/.state/` on a volume, or managed storage; AgentCore: `/mnt/data/.state/`, reset on every deploy |
| Workspace | Rebuildable | `/data/` on a volume or a disposable disk (AgentCore: `/mnt/data/`); acquired again from content declarations at start |

A container instance:

```text
/app/definition/          the image: the program, read-only, with its build in dist/ and the release manifest
/etc/fastagent/           configuration, read-only, delivered with the release: FASTAGENT_CONFIG names its fastagent.json
  fastagent.json  (.mcp.json  AGENTS.md  skills/  prompts/, when an instance adds them)
/data/                    the volume, FASTAGENT_ROOT: the agent's cwd (/mnt/data/ on AgentCore)
  .state/
  content/<entry>/
  ...
environment               secrets injected by the platform, or AgentCore's secret ARN
```

The volume no longer holds a copy of the definition (today's `/data/definition`): the program lives only in the image,
and a volume holds only state and work.

The volume keeps the path generated deployments have always used, `/data` (`/mnt/data` on AgentCore). The filesystem
hierarchy's `/var/lib/<name>/` would separate several agents on one machine, but every host here runs one agent per
app (Fly, Railway, AgentCore) or per Compose project, whose volume is the project's own: a name in the path would buy no
separation and would move every deployed app's mount.

The configuration rides in the image the deploy builds, in the filesystem hierarchy's place for it: `deploy --config
<file>` writes it into `fastagent.deploy/` in the build context, a build output like the release manifest, and the
generated Dockerfile copies that directory to `/etc/fastagent/` after the build (a change of configuration builds nothing
again) and names it with `FASTAGENT_CONFIG`. Without `--config` the directory holds `{}`: the program's defaults. Every
host carries it the same way, AgentCore included. It is a directory of its own, never a file in the program's, because
what an instance configuration names beside it (its `.mcp.json`, its instructions, skills and prompt templates) is read
from its own directory. It carries no name, as `/data` does not: an image holds one agent. A mounted configuration (a
ConfigMap) is the same directory placed by the host instead, named with `FASTAGENT_CONFIG`.
`HOME` stays the user's home (§5's base environment), so files
such as `~/.gitconfig` do not land in the instance root.

Configuration on a writable volume would make the deployment and the agent compete for it, the problem #605 describes.
Delivered read-only, it changes only by deploying again, and an agent cannot add capabilities to a served deployment.

Content in the cloud: a GitHub source is cloned at start (every cold start on AgentCore), and the agent's changes in it
survive only when pushed, which needs `GITHUB_TOKEN`. A local path does not exist on a host: it deploys only when the
host maps it to a mount, and is otherwise refused at preflight, never silently skipped.

### 6.2 Secrets

**A deployment's values are the target's state, never a deploy input.** The definition declares the names it needs
(`needs()`, MCP references, `context.json`'s `variables`, the channels, the model's provider); the values live in the
target's own store, set there by a command of their own; `deploy` checks names and never reads or carries a value
(one a person types during a deploy, or a production app returns, goes straight to the target's store). This is how deployment tools that declare secrets in code or configuration work: Wrangler's `secrets.required`
fails `wrangler deploy` naming each one the Worker lacks and never uploads `.dev.vars`; Encore checks its `secret()`
declarations before a deploy; SST fails with the `sst secret set` command to run. A local `.env` is development's.

Carrying a file was the alternative, and what 0.29.0 does: `--run` uploads the whole production value file. It made
the person deploying hold every production secret, in the project directory a coding agent working there can read,
and it took a run of machinery that exists only to carry: names a deployment sets itself filtered out of the file,
chunked carriers, Compose rewriting `$` in values, gates for a value that differs between the shell and the file. Keeping both
(carry a file, or trust the platform) would have doubled every path.

| Target | Its store | Lists names with |
|---|---|---|
| Docker | `.secrets/production/.env` on the machine running Compose (owner-only), which Compose reads by `env_file:` | the file |
| Fly | Fly secrets | `fly secrets list --json` (names and digests, no values) |
| Railway | the service's variables | `railway variable list --json`, of which only the names are read |
| AgentCore | one JSON secret in Secrets Manager per deployment | the secret's keys |
| `fastagent start`, an embedding app | `--env-file`, the environment, `openAgent({ secrets })` (§4.1) | — |

`fastagent secrets set <host> <NAME>` writes one value: at a terminal it asks without echoing, otherwise it reads
standard input, never the command line. `fastagent secrets push <host> --env-file <file>` writes every value a file
holds, the batch form for CI (`wrangler secret bulk`'s counterpart). `fastagent secrets list <host>` prints the declared
names and which the target has. `--generate` sets a random value and prints it once, for the values FastAgent itself
mints, such as `FASTAGENT_API_KEY`.

`deploy --run` lists the target's names before its first build, once the app or service it sets values on exists (on
Fly and Railway, creating one is the first step and is repeatable). For each missing name it reports what it is for,
where it is declared and whether it is optional, and the command that sets it. At a terminal it asks for each value
then and there and sets it; with `--json` the ticket waits as `need_user_action` with those commands, saying the
person runs them in a terminal and the agent never asks for a value in the conversation, and carries on once the names
are present; with nobody to ask, it stops with the same list.

What `deploy` read values for becomes a name or configuration:

- **Required values** are checked by name, on the target.
- **The model** is configuration (`defaults.model`, a delivered `--config`); the release manifest records no model.
- **The model's credential route** (a variable on the target, or a login on the box): whether the target has the
  provider's variable name.
- **A channel's shape** (Feishu's and Lark's `<PREFIX>_INGRESS`, webhook or WebSocket) is a setting, not a secret:
  it moves into configuration, which `deploy` reads as the box will.
- **Webhook registration** runs on the box, which holds the bot's token, through the host's shell (the one
  `login --deployment` uses), with the URL `deploy` learned.
- **A production Feishu or Lark app** that deploy creates is written to the target's store. The check that it is not
  the development app runs then, the one time deploy holds both App IDs; an app set by hand is the operator's to keep
  apart.

The production value file stays what local `start` reads and Docker's store: `add <channel> --env production` keeps
writing there, and another host's values are set with `fastagent secrets`.

OAuth is created on the deployment itself and never carried: a model provider's login through
`fastagent login --deployment`, an MCP server's grant by signing in against the deployed instance (§4.1; no automatic
relay yet, §8). Deploy reports a declared OAuth server the target has no grant for as missing, alongside missing names.

**AgentCore.** `AWS::BedrockAgentCore::Runtime`'s `EnvironmentVariables` is a plain string map without secure dynamic
references, so the template carries only the secret's ARN. The runtime role is granted `secretsmanager:GetSecretValue`
on that secret, and the container reads it at start. This replaces the chunked `NoEcho` parameter carrier, keeps
plaintext out of CloudFormation, and lets a rotation apply at the next cold start. AgentCore Identity's credential
providers are evaluated later for MCP OAuth, not as the general carrier. *Implementation research:* verify the chain on a
minimal stack.

### 6.3 What a deployed instance can add

| Can add through its configuration | Cannot |
|---|---|
| Remote MCP servers, skill and prompt-template directories in the delivered configuration, scripts using runtimes already in the image | Capabilities needing OS or npm packages the image lacks |

The environment belongs to the program. Users manage the dependencies of their own additions on their own machines;
FastAgent installs nothing for them and mutates no host globally.

## 7. When additions take effect

**Every addition takes effect at an explicit close and reopen**, which selects one snapshot of the configuration for
the life of that open:

- **Text** (instance instructions, skills and prompt templates) is read at open from what the configuration declares
  (§4.2), named as §4.1 says. No per-message rescan bypasses this boundary: one would let one open present different
  model-facing text, and let files the agent writes anywhere in its workspace become capabilities. A local host
  (`dev`, a workbench app) watches the declared files and reopens once the current turns finish; FastAgent provides the
  change notification, so the edit lands without a manual restart. This
  keeps the first draft's rule and changes the current source-directory behavior, where skills and `AGENTS.md` in the
  agent directory are read on the next message ([agent-model.md §6](agent-model.md#6-an-agent-changes-itself)).
- **Connections and executables** (MCP servers, tools) take effect the same way. Apart from that watched reopen, no
  automatic restart and no hot replacement of loaded code.
- An open that cannot assemble its configured set refuses before reporting ready, releases what it acquired and keeps
  its diagnostics. No configured capability is silently dropped.

## 8. Known gaps

Recorded, not solved here:

- Concurrent sessions share one workspace, so two can step on each other's files and git state.
- Scale-out needs state in shared storage and a workspace per replica.
- AgentCore keeps nothing on disk across deploys; only delivered configuration and external secrets persist there.
- A local reproduction runs on this machine's architecture: an image `deploy docker --run` builds on an arm64 laptop
  does not show a native dependency that fails on an amd64 host.
- A deployed instance's MCP OAuth sign-in has no automatic relay (no `mcp login --deployment`): it runs against the
  deployment with a forwarded callback port, and on AgentCore a grant is lost with the storage on every deploy.

## 9. Current implementation seams and evidence

| Current | Change |
|---|---|
| A source project is read as a definition value, its modules imported where they are and nothing written; `start` opens the project's `dist/`, and `openAgent` takes a definition | Build prepares; open loads a built definition |
| `agentDir` supplies cwd, values, local bindings and clone paths | Configuration, state and workspace are separate inputs |
| Runtime prompt describes an editable definition in cwd | Immutable program; workspace and configuration |
| Deploy copies and replaces the author directory | Deploys the artifact plus delivered configuration; state preserved |
| `.secrets/<env>/.env` carries instance settings | `fastagent.json` carries settings; env files carry secrets |
| `config.model`, `http`, `deploy` read as fixed values | Read as program defaults under instance overrides |
| Hosts mount `/data` (`/mnt/data` on AgentCore) holding `definition/`, `.state/`, `.secrets/` | The configuration delivered in the image's `/etc/fastagent/` and `/data/` as the instance root, the agent's cwd (`/mnt/data/` on AgentCore); the definition stays in the image |
| `needs()` and MCP references read `{ ...process.env, ...values }` at open | Secrets are an input: the CLI's environment and `--env-file`, or `openAgent`'s `secrets` |
| `deploy --run` carries the production value file to the host, and reads values to plan | Values are the target's state, set with `fastagent secrets`; `deploy` checks names only (§6.2) |
| `modelsOver` resolves a provider's variable as `environment[name] \|\| process.env[name]` | The model's auth reads only the `secrets` input |

Disposable probes on 0.29.0 executed a source tarball after extraction on Node 26.11.1, Bun 1.4.4 and native Linux ARM64
(Node 24.15.0), including tools, data, skills, prompts, the official Filesystem MCP 2.1.0 and Agent HTTP calls. Direct
execution under `node_modules` failed with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`; a compiled entry imported, but
the opener generated TypeScript again and ignored a `.js` config (`missing_model`). Read-only startup failed on
`.fastagent` writes despite external state. `npm pack` included a nested skill `.env`. Two opens of one definition with
different `stateDir` values shared cwd, relative output files, local content bindings and default values. These are
boundary experiments, not a supported format.

## 10. Delivery

1. **Artifact.** A compiled `dist/` with its `bin`, installed under `node_modules`, opened read-only with explicit
   inputs, two independent instances, on Node and Bun. Add pi-schema; the move to pi 1.5.0 is separate (#903).
2. **Inputs.** The four-input contract with the instance root, `fastagent.json`, one resolver for API objects and
   files, the configuration shape of §3.2, the default locations and the scaffold's npm scripts; `context.local.json`
   removed.
3. **Deployment.** Derived from the same artifact with delivered configuration in the image's `/etc/fastagent/` and the instance
   root at `/data/` (`/mnt/data/` on AgentCore); values as the target's state (`fastagent secrets`, names checked by deploy, channel shape as configuration, webhook
   registration on the box), AgentCore through Secrets Manager.
4. **Instance additions.** Content and `.mcp.json` entries, text additions, the reopen boundary.
5. Any public [SPEC](../SPEC.md) change is reviewed on its own.

No backward-compatibility or migration layer is carried; there are no users to migrate.

Deferred until a real need:

- Running a published third-party agent package as an instance of someone else's, with upgrade-conflict handling.
- Persistent capabilities an agent writes for itself, with candidate/accepted/effective states, provenance and
  revocation, packaged like `dist/` when built.
- Persistent additions on AgentCore.
- Cloud storage and cloud document content sources; the first slice is local directories and GitHub.
- Native JavaScript additions.
- Context packages, registries, marketplaces, orchestration and sandboxing.
