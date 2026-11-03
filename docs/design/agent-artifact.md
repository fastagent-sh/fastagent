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
2. `dev` can run with cloud constraints (read-only package, empty state, disposable workspace) and reproduces a cloud
   failure locally.
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
3. **A running instance writes only its state.** An open (`openAgent`, `dev`, `start`, a deployment) never writes the
   package, the configuration it was given, or secret inputs. The CLI's editing commands (`content add`, `env add`,
   `add <channel>`) are authoring and operating tools, not the running instance: each writes only the file it targets
   (§3.3, §4.2, §6.2).
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
  mcp.json                 default MCP servers; references, never credential values
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
import { defineAgent, obj, opt, str } from "@fastagent-sh/fastagent";

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
  Schema with static types, the same schema language pi-durable 1.5.0 uses for tool parameters (this requires moving to
  pi 1.5.0). Secrets stay with `needs()` beside the code that reads them; `settings` is for non-secret values.
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
instance configuration instead (§4.2). Both edits keep the existing lock. `context.local.json` goes away: a machine's
own bindings belong to the instance.

`mcp.json` is the default MCP servers in the standard `mcpServers` shape, with secret references by name.

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
  environment), and the commands the environment requires. A host shows what an instance still needs from this list
  rather than parsing files; deploy's missing-value report uses the same list. Other fields are internal and may change
  between releases. A symbol brand lets `openAgent` recognize a built definition.
- It is typed by its settings (`AgentDefinition<Settings>`), so an embedder's `settings` input is checked by the compiler.
- It is customized only through `openAgent(definition, inputs)`, never by mutation, which keeps the assembly
  deterministic.
- An agent package declares `@fastagent-sh/fastagent` as a peer and a dev dependency, so an app holds one framework
  copy. The framework re-exports the authoring API (`defineTool`, schema builders), so that is the only peer.
- `format` is an integer independent of the framework's semver; `openAgent` refuses an incompatible one and names the
  version it needs. The peer range governs installation; `format` governs what opens.

## 4. The instance

### 4.1 Inputs

An instance is four inputs:

| Input | Holds | FastAgent |
|---|---|---|
| **Configuration** | `fastagent.json` and `.mcp.json`, or the same schema as an API object | Reads only |
| **Secrets** | Values for the names `needs()`, MCP `${VAR}` references and `context.json`'s environment declare | Reads only; held in memory, never written |
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
| `fastagent start` and `npm start` in a project | Only what `--config` or `FASTAGENT_CONFIG` names; otherwise the program's defaults | `.fastagent/start/` in the project |
| The package's `bin` (`npx @acme/reviewer`) | Only what `--config` or `FASTAGENT_CONFIG` names; otherwise the program's defaults | None: `--root` or `FASTAGENT_ROOT` is required |
| Docker, Fly, Railway | `/etc/<name>/`, baked into a derived image or mounted | `/var/lib/<name>/`, the volume |
| AgentCore | `/etc/<name>/`, baked into a derived image | `/mnt/<name>/`, SessionStorage, reset on every deploy |
| Embedding | The `config` object; otherwise the program's defaults | None: `root`, or `stateDir` and `workdir`, are required |

`<name>` is the instance name (§4.5). The paths follow the filesystem-hierarchy convention of naming a directory after
the application, which here is the agent, not the framework, so several agents on one machine never collide.
`/var/lib/<name>/` applies where the host lets the mount point be chosen; AgentCore's SessionStorage must mount at
exactly `/mnt/<one level>` (as `src/deploy/agentcore/plan.ts` notes), so there the root is `/mnt/<name>/`, named to
the runtime through `FASTAGENT_ROOT`. `start`
never reads the development `fastagent.json`: production inputs are explicit. A project-relative default is anchored to
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
  `secrets` is distinct from `credentials`, the model providers' credential store (sign-ins and API keys pi-ai
  resolves), which today's `openAgent` already takes. An implicit read would let a stray shell variable open a
  different instance, breaking assembly determinism. (Today `openAgent` falls back to `FASTAGENT_STATE_DIR`; that changes.)
- External data the agent works on needs no separate root: it is a `path` entry under `content`, and clones live in the
  workspace.
- `FASTAGENT_AUTH_PATH` and `FASTAGENT_SECRETS_DIR` remain finer overrides; their defaults move under the state root.

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
- Skills and prompt templates are namespaced instead of refused. A program's have a full name `<program>:<name>`
  (`reviewer:review`); an instance's are bare, since an instance is what opens. A program's bare name is an alias
  while no instance entry takes it. When one does, the bare name is the instance's, the program's stays listed and
  invocable by its full name, and the open reports the overlap. A program upgrade that adds a name an instance already
  uses therefore never stops the instance from opening. The command spelling under `/skill:` is settled in
  implementation.

**MCP: three different things.** A server's declaration (`command` or `url`, `args`, headers with `${VAR}`
references) is configuration: the program's `mcp.json` declares the servers every instance connects, an instance's
`.mcp.json` or `mcpServers` adds its own, and neither ever holds a secret value. The values those references name are
secrets, the same input `needs()` reads; today's `McpOptions.variables` merges into `secrets`. An OAuth grant, created
when a person authorizes in a browser and refreshed afterwards, is state: it lives in the grant store (under `.state/`
by default, or a host's own) and an instance's binding says which grant a server uses. `mcp` keeps `store`, `bindings`
and `fetch` ([mcp-auth.md](mcp-auth.md)). A program-declared server without its required value or grant refuses the
open and says what is missing.
- An instance layers only on the program's defaults, never on another instance.

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
additional content sources (including the machine-local bindings `context.local.json` held before), and the
instance's own instructions, skills and prompt templates. `instructions` names files added after the program's text;
`skills` and `prompts` name directories. All are relative to `fastagent.json`, and only what is declared loads: a file
the agent writes elsewhere in its workspace never becomes a capability. Where the configuration directory is the
writable instance root (a local instance, §4.6), the person and the agent can add to these directories, taking effect
at the next open (§7); deployed, they ship in the read-only configuration (`/etc/<name>/skills/`). A directory that
resolves to the program's own `skills/` or `prompts/`, or inside the program, is a configuration error reported at
open: it would offer the program's capabilities twice. In a development project the root's `skills/` is the
program's, so a development instance names other directories. `content add` writes this file by default: the
development instance's at the project root, or the one `--config <file>` names; `--program` targets the program's `context.json` instead (§3.3). `.mcp.json` stays a file of its own because it is the ecosystem's format: entries copy from any
server's documentation, and Claude Code working in the same directory reads the same servers, which is intended.

A secret value never appears in either file; both reference secrets by name.

### 4.3 Development defaults

In a project, `fastagent dev` defaults its inputs so a new agent needs no flags: configuration and `.mcp.json` from the
project root when present, secrets from `.secrets/.env`, and the instance root `.fastagent/dev/` (§4.1). The
workspace is kept apart from the source, so `dev` runs the same shape as a deployment. At the root, the program's
`mcp.json` (packaged defaults) and the development instance's `.mcp.json` (additions, read by Claude Code too) sit side
by side; the names and §4.1's composition rule keep them distinct. Other environments are other inputs, given
explicitly. How a team lays out per-environment files, what it commits and whether it keeps a personal local layer is
the developer's choice; the framework adds no local layer.

`.fastagent/dev/` sits inside the author's repository, where git run in the workspace would otherwise find and act on
the author's repository, while on a host there is no repository above `/var/lib/<name>/`. The child environment (§5)
therefore sets `GIT_CEILING_DIRECTORIES` to the instance root's parent for every instance, so git discovery stops at
the root everywhere and an agent cannot commit the author's source by walking upward. Cloud-constraint mode checks it.

`dev` loads the definition through the same assembly as a deployment and can run with cloud constraints (§1).

The agent's tools can write its own instance configuration in development. That is accepted: an instance is one trust
domain, the change takes effect at the next open, and version control shows it. Deployed configuration is read-only
(§6.1). A local host watches the declared configuration (§7) and reopens after the current turns finish, so an edit
lands without a manual restart.

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
`fastagent.json`; an app that keeps its instances as folders passes the file's path instead (§4.6). Two opens with different inputs share nothing: no cwd, relative output, binding or default.

### 4.5 Identity

An instance's name is an explicit input (`--name`, `FASTAGENT_NAME`, `name`; §4.1). It defaults to the definition's
name, normalized to one path segment (`@scope/pkg` is not one), because a deployment joins it onto storage and
resource names; two instances of one definition on one machine take distinct names. `config.name` is for display.

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
- A stdio server given through the API (`openAgent({ mcp })`) has no declaration file: it must carry an absolute `cwd`,
  and a command containing a path must be absolute. Otherwise the open is refused; nothing falls back to the process's
  cwd.
- No `process.chdir()` and no `process.env` mutation select an instance.

**The child environment.** Every process the instance starts (the shell tool, stdio MCP servers, skill scripts) gets
an environment assembled from inputs, never the host process's whole `process.env`:

1. a base: `PATH`, `HOME`, `USER`, `SHELL`, `LANG`, `LC_*`, `TZ`, `TMPDIR` and the proxy variables (`HTTP_PROXY`,
   `HTTPS_PROXY`, `NO_PROXY`). The CLI copies these from its own environment; `openAgent` takes them from its `env`
   option, and an embedding app that wants its own passes them (`env: baseEnv(process.env)`, a helper FastAgent exports);
2. the secrets the definition declares (`needs()`, `context.json`'s environment) that the `secrets` input supplies;
   undeclared names are not passed on;
3. an MCP entry's own `env` for that server;
4. `GIT_CEILING_DIRECTORIES` set to the instance root's parent (§4.3).

So a stray variable in the host's shell cannot reach a command, and a declared variable reaches every one. The base
list is part of the assembly that `info` reports.

## 6. Cloud deployment

### 6.1 What goes where

`fastagent deploy <host>` derives a deployment from the project's artifact and the selected instance inputs:

| Part | Lifecycle | In the cloud |
|---|---|---|
| Program | Per version | The image, read-only |
| Configuration | Per deployment | Delivered with the deployment, read-only: baked into a derived image or mounted; both are supported |
| Secrets | Per deployment, rotatable | The platform's secret storage |
| State | Durable | `/var/lib/<name>/.state/` on a volume, or managed storage; AgentCore: `/mnt/<name>/.state/`, reset on every deploy |
| Workspace | Rebuildable | `/var/lib/<name>/` on a volume or a disposable disk (AgentCore: `/mnt/<name>/`); acquired again from content declarations at start |

A container instance:

```text
/app/                     the image: the program, read-only
/etc/<name>/              configuration, read-only (derived-image layer or mount)
  fastagent.json  .mcp.json  AGENTS.md  skills/  prompts/
/var/lib/<name>/          the volume, FASTAGENT_ROOT: the agent's cwd (/mnt/<name>/ on AgentCore)
  .state/
  content/<entry>/
  ...
environment               secrets injected by the platform, or AgentCore's secret ARN
```

The volume no longer holds a copy of the definition (today's `/data/definition`): the program lives only in the image,
and a volume holds only state and work.

Configuration on a writable volume would make the deployment and the agent compete for it, the problem #605 describes.
Delivered read-only, it changes only by deploying again, and an agent cannot add capabilities to a served deployment.

Content in the cloud: a GitHub source is cloned at start (every cold start on AgentCore), and the agent's changes in it
survive only when pushed, which needs `GITHUB_TOKEN`. A local path does not exist on a host: it deploys only when the
host maps it to a mount, and is otherwise refused at preflight, never silently skipped.

### 6.2 Secrets

| Host | A (default): `--env-file <path>` given | B: no file; values already on the platform |
|---|---|---|
| Docker | Compose `env_file:` names the given file | Compose `environment:` lists names only; values come from the environment running Compose |
| Fly, Railway | Set through the platform's CLI | Nothing set; the platform's existing names are compared with the declared ones |
| AgentCore | Written to one per-deployment JSON secret in Secrets Manager | `--secret-arn` names an existing secret; deploy only grants access |

The names a deployment needs come from `needs()`, MCP references, `context.json`'s environment and the channels. Mode A
checks the file; mode B checks the platform where it can list names, and startup's check covers the rest.

**AgentCore.** `AWS::BedrockAgentCore::Runtime`'s `EnvironmentVariables` is a plain string map without secure dynamic
references, so the template carries only the secret's ARN. The runtime role is granted `secretsmanager:GetSecretValue`
on that secret, and the container reads it at start. This replaces the chunked `NoEcho` parameter carrier, keeps
plaintext out of CloudFormation, and lets a rotation apply at the next cold start. AgentCore Identity's credential
providers are evaluated later for MCP OAuth, not as the general carrier. *Implementation research:* verify the chain on a
minimal stack.

**Missing values.** Deploy reports, for a person and for a coding agent alike:

- each missing name, what it is for, where it is declared, whether it is optional;
- the host's commands to set it, following that host's recommended practice (*implementation research* per host),
  reading values from standard input rather than the command line where the host allows it;
- optionally, `--write-env-example <path>` writes a placeholder file with names and descriptions and no values;
- with `--json`, a `need_user_action` result carrying the above, and the instruction that a coding agent hands the
  command or file to its person instead of asking for a secret in the conversation.

These change from implicit to explicit inputs: `add <channel> --env production` and Feishu app creation write values to
a target the operator names; the dev/production App ID isolation check runs when both inputs are given; preflight reads
what it was given.

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

## 9. Current implementation seams and evidence

| Current | Change |
|---|---|
| `prepareDefinition` generates the TS registry and writes the secrets manifest on open | Build prepares; open loads a built definition |
| Opening expects `fastagent.config.ts` in a directory | Open accepts a built definition object |
| `agentDir` supplies cwd, values, local bindings and clone paths | Configuration, state and workspace are separate inputs |
| Runtime prompt describes an editable definition in cwd | Immutable program; workspace and configuration |
| Deploy copies and replaces the author directory | Deploys the artifact plus delivered configuration; state preserved |
| `context.local.json` and `.secrets/<env>/.env` carry instance settings | `fastagent.json` carries settings; env files carry secrets |
| `config.model`, `http`, `deploy` read as fixed values | Read as program defaults under instance overrides |
| Hosts mount `/data` (`/mnt/data` on AgentCore) holding `definition/`, `.state/`, `.secrets/` | `/etc/<name>/` for configuration and `/var/lib/<name>/` as the instance root; on AgentCore `/mnt/<name>/`; the definition stays in the image |
| `needs()` and MCP references read `{ ...process.env, ...values }` at open | Secrets are an input: the CLI's environment and `--env-file`, or `openAgent`'s `secrets` |

Disposable probes on 0.29.0 executed a source tarball after extraction on Node 26.11.1, Bun 1.4.4 and native Linux ARM64
(Node 24.15.0), including tools, data, skills, prompts, the official Filesystem MCP 2.1.0 and Agent HTTP calls. Direct
execution under `node_modules` failed with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`; a compiled entry imported, but
the opener generated TypeScript again and ignored a `.js` config (`missing_model`). Read-only startup failed on
`.fastagent` writes despite external state. `npm pack` included a nested skill `.env`. Two opens of one definition with
different `stateDir` values shared cwd, relative output files, local content bindings and default values. These are
boundary experiments, not a supported format.

## 10. Delivery

1. **Artifact.** A compiled `dist/` with its `bin`, installed under `node_modules`, opened read-only with explicit
   inputs, two independent instances, on Node and Bun. Move to pi 1.5.0 and pi-schema.
2. **Inputs.** The four-input contract with the instance root, `fastagent.json`, one resolver for API objects and
   files, the configuration shape of §3.2, the default locations, `dev` cloud-constraint mode and the scaffold's npm
   scripts; `context.local.json` removed.
3. **Deployment.** Derived from the same artifact with delivered configuration under `/etc/<name>/` and the instance
   root under `/var/lib/<name>/` (`/mnt/<name>/` on AgentCore); secret modes A and B, missing-value guidance, AgentCore through Secrets Manager.
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
