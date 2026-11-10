---
title: Where configuration, secrets and credentials live
description: "The layout that replaces today's many places for values: a named instance with one committed configuration file, delivered to a host as its own variables so one image serves every instance; secrets in the platform's store; one `.env` for local work; credentials in one user-level layer."
type: design-doc
status: proposed
---

# Where configuration, secrets and credentials live

**Status: proposed.** Nothing here is built. Once accepted it replaces the value-file and `.secrets/` parts of
[agent-artifact.md](agent-artifact.md) §4.1 and §6, which are rewritten with the code, not before. The code is `src/`.

## 1. The problem

The same kind of value lives in several places, each with its own directory, variable or flag. It is not one decision:
each case (a project, an app, a container volume, a second environment) added a place and none was retired.

| What | Places today |
|---|---|
| Values that become the environment | `<agent>/.secrets/.env`, `<agent>/.secrets/production/.env`, `--env-file`, `FASTAGENT_SECRETS_DIR/.env`, the process environment, and a bare `<agent>/.env` that is not read but warned about |
| Model credentials (`auth.json`, `device.json`) | `<agent>/.secrets/`, `~/.fastagent/.secrets/auth.json`, `FASTAGENT_AUTH_PATH`, `FASTAGENT_SECRETS_DIR`, `<root>/.state/` for an app |
| MCP grants (`mcp-auth.json`) | `<agent>/.secrets/` for the CLI, `<root>/.state/` for an app (`keeps: "secrets" \| "state"` in `openServing`) |
| Instance state and working directory | `.fastagent/dev/`, `.fastagent/start/`, `--root`, `--state`, `--workdir`, `FASTAGENT_ROOT`, `FASTAGENT_STATE_DIR`, `FASTAGENT_WORKDIR`, `/data`, `/mnt/data` |
| Instance configuration | the project's `fastagent.json`, `--config`, `FASTAGENT_CONFIG`, `/etc/fastagent/fastagent.json` baked into the image, `<root>/fastagent.json` for an app |

Three causes, each visible in the code and `git log`:

- **The CLI is anchored to a project, an app to an instance.** `.secrets/` belongs to a project; an app has none, so
  `openServing` grew `keeps` and a second layout.
- **Each target added a way to move a directory** (`FASTAGENT_STATE_DIR`, `FASTAGENT_SECRETS_DIR`,
  `FASTAGENT_AUTH_PATH`; #280, #306, #496), and a second environment added `.secrets/production/` (#769).
- **Two things were put where they do not belong.** Non-secret deployment values (`FASTAGENT_MODEL`) are read by
  `deploy` from a file named for secrets, which a CI job does not have. And the instance's configuration is copied into
  the image, so each instance is its own image.

## 2. What comparable tools do

| Tool | One program, many instances |
|---|---|
| Pulumi | one program, a stack per environment, each with a committed `Pulumi.<stack>.yaml`; secrets encrypted in it |
| Wrangler | one code base, `[env.<name>]` with its own `vars` and bindings (not inherited), each environment a Worker of its own; `wrangler secret put --env` |
| Serverless Framework | `stages:` with `params` per stage; a secret is `${env:PROD_KEY}`, taken from the CI's environment |
| SST | `--stage` names the instance and prefixes its resources; secrets per stage; `.env` files discouraged |
| Helm | one chart, one values file per release (`-f environments/prod/payments.yaml`); CI names the release and the file |
| AWS silo, Azure deployment stamps | one code base, one instance per customer, a per-customer configuration file kept outside the application artifact and deployed by automation |

What they share:

1. The instance is **named**, and the name prefixes what the host creates. It is any string: a stage, a customer.
2. Its non-secret configuration is **one committed file**, read by the deploy tool when it deploys.
3. The deploy tool **renders that file into the platform's own mechanism** (Wrangler's vars, a function's environment, a
   ConfigMap); the code artifact does not change between instances.
4. Secrets are separate, held per instance by the platform, and a CI job injects them from its own store.
5. A `.env` file is for local work.

## 3. The rule

A value is placed by what it is.

| Kind | Example | Lives in | Committed |
|---|---|---|---|
| The program | prompt, skills, code, `defaults`, `context.json` | the definition | yes |
| An instance's non-secret configuration | `name`, `model`, `thinkingLevel`, `http.*`, `channels.<name>.ingress`, `settings`, `content`, `mcpServers` | a configuration file, one per instance, given to `deploy --config` | yes |
| A secret | provider key, channel token, `GITHUB_TOKEN` | the target's own secret store, set by `fastagent secrets` or by the CI | never |
| A value for local work | the same secrets on one machine | `<agent>/.env` | never |
| A credential a tool writes and refreshes | `auth.json`, `device.json`, MCP grants | one user-level layer, `~/.fastagent/` (an app keeps its own in its state) | never |
| Per-instance state | sessions, channel state, clones | the instance root | never |

## 4. The instance

An instance is a **named deployment of a program with one configuration file**.

- Its name is the file's `name`, else the program's name as one segment (what `info().name` already says). There is no
  `--stage` and no `--name` for a deploy: another customer is another file with another `name`.
- The name is what a host's resources are called: Fly's app, Railway's service, AgentCore's runtime and stack, Compose's
  project. Today they come from the agent directory's name, so two instances of one directory collide.
- A host manifest FastAgent generates for an instance carries the name (`fly.<name>.toml`,
  `fastagent.<name>.compose.yml`, `agentcore.<name>.template.yaml`) and is committed and hand-adjustable as today. The
  `Dockerfile` and `.dockerignore` are the program's and are shared, since they hold nothing of an instance.
- The storage a deployment starts on belongs to one instance name; a deploy that finds another's refuses, as it does now.

## 5. Delivery

**The image holds the program and nothing of an instance**, so one build is every instance's image. Nothing is copied to
`/etc/fastagent/`, and there is no release manifest; what varied per deployment goes to the host as variables the deploy
sets: the configuration (below), `FASTAGENT_NAME` (the instance's name, the variable that already carries it; the
storage claim and the lease use it) and `FASTAGENT_RELEASE_ID` (for the log and the record of the release last started
on the storage). `FASTAGENT_NAME` is also set on local instances, so it cannot say "this is a deployed box"; the
presence of `FASTAGENT_RELEASE_ID` does.

The configuration file is delivered as one variable holding its JSON, `FASTAGENT_CONFIG_JSON`, rendered by the host's own
mechanism for non-secret values:

| Host | Rendered into | Note |
|---|---|---|
| Docker | the instance's Compose file, `environment:` | a `$` in the text (an MCP server's `${VAR}`) is written `$$`, or Compose would expand it |
| Fly | the instance's `fly.toml`, `[env]` | Fly documents `[env]` for non-sensitive values |
| Railway | the service's variables in that environment, set with `railway variable set` | variables are not part of Railway's config file |
| AgentCore | the template's `EnvironmentVariables` | AWS's quota is 4 KB in all with 50 entries, and the CloudFormation page lists a maximum of 2048 with no unit; to be measured (§7) |

The box reads, in order: a flag, the individual variables (`FASTAGENT_MODEL`, `FASTAGENT_THINKING_LEVEL`,
`FASTAGENT_HTTP_API`, `FASTAGENT_HTTP_PUBLIC_URL`, `FASTAGENT_INGRESS`), `FASTAGENT_CONFIG_JSON`, the program's
`defaults`. A variable the platform holds therefore changes one value without redeploying.

`deploy` reads the file itself, so it plans with the model, the Agent API switch and the public URL that the box will
run with: the pre-flight checks the model's credential route against the file's `model`, and a CI job with a different
model per instance has a file per instance.

The rendered text lands in files meant to be committed (`fly.<name>.toml`, the Compose file, the AgentCore template) and,
on AgentCore and Fly, in what the platform shows (`describe-stacks`, the app's configuration); Fly documents `[env]` for
non-sensitive values only. So a literal credential in the configuration (a header or `env` value of an `mcpServers`
entry that is not a `${VAR}` reference) stops being a warning and is refused by the pre-flight, which says to write
`${VAR}` and set the value as a secret. Today the configuration is in a git-ignored directory and an image layer, and
the same finding only warns.

A configuration that cannot be a variable is refused by the pre-flight, naming the host and its limit:
a `content` entry that is a directory of this machine, an `mcpServers` command that is a relative path, a file over the
host's limit, and `instructions`, `skills` or `prompts`: a deployment's text is the program's, and an instance does not
add to it on a host.

## 6. What each place becomes

| Today | After |
|---|---|
| `<agent>/.secrets/.env` | `<agent>/.env`, read by `dev` and `start`; `start` also takes `--env-file` |
| `<agent>/.secrets/production/.env`, `FASTAGENT_ENVIRONMENT` | removed; any file through `--env-file` |
| `FASTAGENT_SECRETS_DIR` | removed |
| `<agent>/.secrets/auth.json`, `device.json` | `~/.fastagent/` (one layer; `FASTAGENT_AUTH_PATH` places it elsewhere) |
| `<agent>/.secrets/mcp-auth.json` | `<root>/.state/` |
| `.secrets/` and its ignore file | removed; the committed template is `<agent>/.env.example` |
| `/etc/fastagent/fastagent.json`, `FASTAGENT_CONFIG` on a box | `FASTAGENT_CONFIG_JSON` |
| `fastagent.release.json`, `FASTAGENT_RELEASE_FILE` | removed; `FASTAGENT_NAME` and `FASTAGENT_RELEASE_ID` (its presence marks a deployed box); `model` is in the configuration |
| `deploy` reading `FASTAGENT_MODEL`, `GITHUB_TOKEN`, `FASTAGENT_API_KEY` from a value file | the file's `model`; the others are secrets the target holds |
| `fastagent secrets set docker`, Compose `env_file:` | Compose's `environment:` with names only (`- OPENAI_API_KEY`), which Compose fills from the shell running it, so a CI job's variables reach the box; `secrets set docker` is removed |
| `FASTAGENT_ROOT`, `FASTAGENT_STATE_DIR`, `FASTAGENT_WORKDIR`, `FASTAGENT_CONFIG` and the flags | unchanged for a local instance |

Decided:

- **One credential layer, the user's.** `gh`, Claude Code and Codex keep credentials per user (`GH_CONFIG_DIR`,
  `CLAUDE_CONFIG_DIR`, `CODEX_HOME` place them), not per project, and a local credential never reaches a deployment (the
  box logs in itself). So `dev` and `start` share one login; the project layer and `keeps` go.
- **`dev` and `start` both read `<agent>/.env`**, as `next start` does. A deployed box reads only its environment.
- **Docker takes secrets as environment variables, like every other host.** The Compose file names each declared secret
  (`environment: [OPENAI_API_KEY]`) and Compose fills it from the shell that runs it, so one mechanism serves all four
  hosts and the box reads nothing new. Compose issues no warning for a name the shell does not set, so the pre-flight
  checks that each declared name is set in the environment that will run Compose, reading no value, and stops when one is
  not. Compose's own `secrets:` (files under `/run/secrets`) keeps values out of
  `docker inspect`, but it is one host's mechanism and would need a second read path in the box; not taken.
- **A deployment's text is the program's.** An instance on a host adds no `instructions`, `skills` or `prompts`.
- **The release facts are variables**, not a file in the image (§5), because the manifest's random id would make every
  deploy, and every instance, a different image.

## 7. Open

These are decided by measuring or building, not by argument.

1. **AgentCore's limit.** The API quota says 4 KB of environment variables in all, the CloudFormation page says
   `Maximum: 2048` without a unit. The pre-flight needs the measured number for the whole set, not only the
   configuration.
2. **Railway's limits** for a variable's size, and whether `railway variable set` takes JSON with quotes as is. Its
   config file does not carry variables; one search summary says config-as-code is deprecated for new services, which is
   not verified.

## 8. Migration

One PR each, in this order; each leaves the product working. No compatibility layer, per the maintenance policy.

1. **Name.** The instance name from the configuration; host resources, generated manifests and the storage claim use it.
2. **Delivery.** The image holds the program only; `FASTAGENT_CONFIG_JSON`, `FASTAGENT_NAME` and
   `FASTAGENT_RELEASE_ID` rendered per host; `delivered-text`, the `/etc/fastagent/` layer and the release manifest go;
   the pre-flight refuses what cannot be a variable.
3. **Secrets.** `deploy` reads no value file; Docker's Compose file names the declared secrets and takes their values from the shell; `.secrets/production/` and `FASTAGENT_ENVIRONMENT` go.
4. **Local values.** `<agent>/.env` for `dev` and `start`; the scaffold, ignore rules and `.env.example` follow.
5. **Credentials.** The user-level layer; `.secrets/`, `keeps` and `FASTAGENT_SECRETS_DIR` go.
6. The user documents and agent-artifact.md §4.1 and §6 are rewritten for the new layout.

## 9. Not decided here

- A box's own writable configuration layer and editing it at run time ([agent-artifact.md](agent-artifact.md) §4.2).
- Whether an instance's MCP servers may expand every secret it was opened with (#997).
