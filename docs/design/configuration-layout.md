---
title: Where configuration, secrets and credentials live
description: "The layout that replaces today's many places for values: a named instance with one committed configuration file, delivered to a host as its own variables so one image serves every instance; secrets in the platform's store; one `.env` for local work; credentials in one user-level layer."
type: design-doc
status: proposed
---

# Where configuration, secrets and credentials live

**Status: proposed, partly built.** Steps 1 to 3 of §8 are in the code (the instance's name, delivery as variables,
`deploy` reading no value file); the rest is not. Once accepted it replaces the value-file and `.secrets/` parts of
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
| Instance configuration | the project's `fastagent.json`, `--config`, `FASTAGENT_CONFIG`, `FASTAGENT_CONFIG_JSON` on a deployed box, `<root>/fastagent.json` for an app |

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
image's `FASTAGENT_DEPLOYED` does (§6: a mark held in a platform variable that is edited or deleted would turn a deployed box into a local-looking one that skips the storage's mount check).

The configuration file is delivered as one variable holding its JSON, `FASTAGENT_CONFIG_JSON`, rendered by the host's own
mechanism for non-secret values:

| Host | Rendered into | Note |
|---|---|---|
| Docker | the instance's Compose file, `environment:` | a `$` in the text (an MCP server's `${VAR}`) is written `$$`, or Compose would expand it |
| Fly | the instance's `fly.toml`, `[env]` | Fly documents `[env]` for non-sensitive values |
| Railway | the service's variables in that environment, set with `railway variable set` | variables are not part of Railway's config file |
| AgentCore | the template's `EnvironmentVariables` | at most 50 entries, a key of at most 100 and a value of at most 5000 characters (measured, §7); the 4 KB total in AWS's quota is not measured |

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
| `fastagent.release.json`, `FASTAGENT_RELEASE_FILE` | removed; `FASTAGENT_NAME` and `FASTAGENT_RELEASE_ID`, and the image's `FASTAGENT_DEPLOYED` marks a deployed box; the value file's `FASTAGENT_MODEL` is laid over the delivered configuration's `model` |
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
- **The mark of a deployed box is the image's**, `FASTAGENT_DEPLOYED=1` in the generated Dockerfile (a hand-written one sets it
  too, or `--run` stops), and the variables that name the release are required once it is set. Held in a platform
  variable instead, a deleted or mistyped one would start the box as a local instance on the image's disk, with no mount
  check, no lease and no owner, and nothing would say so.
- **The release facts are variables**, not a file in the image (§5), because the manifest's random id would make every
  deploy, and every instance, a different image. The id is a digest of the name and the configuration, not a random
  value: it is rendered into manifests meant to be committed, and a random one would change them at every deploy.

## 7. Limits, measured and not

Measured on 2026-11-11 against a real account (the checks created nothing that lasts: a temporary IAM role and a
temporary Railway project, both deleted).

| Host | Measured | How |
|---|---|---|
| AgentCore, per entry | at most **50** entries, a key of at most **100** characters, a value of at most **5000** characters. The server refuses each with `Member must have length less than or equal to …` | `create-agent-runtime` with 51 entries, a 101-character key and a 5001-character value |
| Railway, per variable | at most **32768** characters (`value exceeds maximum length of 32768`); 32768 characters are stored whole and read back identical. It counts characters, not bytes: 20000 two-byte characters (40000 bytes) were accepted | `railway variable set --stdin` at 1 KB, 8 KB, 32 KB, 32 KB + 1, 64 KB and 128 KB, read back with `variable list --json` |
| Railway, total | **no limit seen**: 618 variables and about 245,000 characters in one service were stored | 500 small variables in one call, then five 32768-character values |
| Railway, content | a JSON text with quotes and `${TOKEN}` is stored and read back byte for byte | one set, one read |

Measured with `aws-cli` 2.37.11 and `railway` 5.71.0, AgentCore in `ap-southeast-1`. The order in which AgentCore
validates a request (each entry, then the image) is part of why its total was not reached below, so a measurement is
worth repeating when either CLI or the service moves on.

Not measured, and the design must not assume:

1. **AgentCore's total, and its unit.** AWS's quota says 4 KB of environment variables in all, and the CloudFormation
   page lists a maximum of 2048 with no unit. Every request with up to 9,000 characters in two entries passed the
   per-entry checks and stopped at the next one (the image check of a runtime that does not exist), so the total was
   never reached. Measuring it needs a runtime that can be created, that is an image in a repository, which is what the
   deploy itself builds; the first real deploy of this design measures it. Until then the pre-flight takes **4096** as
   the limit of the whole set of variables and says that the limit is not measured.
   - **It counts the set, not the configuration alone.** The template already sets eight variables of its own (`PORT`,
     `FASTAGENT_AGENTCORE`, `FASTAGENT_ROOT`, `FASTAGENT_STATE_DIR`, `FASTAGENT_SECRETS_DIR`, the secret's ARN, and the
     ingress and wake secrets), and the design adds `FASTAGENT_NAME`, `FASTAGENT_RELEASE_ID` and
     `FASTAGENT_CONFIG_JSON`. The configuration's room is 4096 less what the others take, and the pre-flight names both
     numbers when it refuses.
   - **Values count as they will be set, not as the template is written.** Three of the eight are CloudFormation
     parameters (`!Ref`), whose values (an ARN, two minted random strings) exist only at deploy time, so the pre-flight
     counts the final values, never the template text. Any estimate of the others made before they exist (for instance
     "about 250 characters") is not a figure to build on.
   - **Count UTF-8 bytes.** The unit (characters or bytes) is not known; a configuration with non-ASCII text weighs more
     in bytes, so counting bytes is the cautious reading. Railway counts characters (measured above), and the two
     differ, so each host's check uses its own unit.
2. **Docker and Fly.** Neither was measured. Fly's configuration reference states no size for `[env]` (only that values
   are strings and that the section is for non-sensitive data). On Docker the limit comes from Linux and not from
   Compose: reports and the kernel's `MAX_ARG_STRLEN` put one environment string at about 128 KB and charge the whole
   environment against the same budget as the arguments (`ARG_MAX`). A configuration of the sizes above fits in both
   by a wide margin, but that is an expectation, not a result.
3. **Railway's config file** does not carry variables, and one search summary says config-as-code is deprecated for
   new services; not verified.

Consequence for the delivery (§5): the configuration is one variable, which fits Railway up to 32768 characters and
AgentCore up to 5000 for one variable and, with the rest of the set, 4096 in all (until its total is measured). A
configuration over a host's limit is refused by the pre-flight naming the limit. Of the hosts measured, none needs the
file split across variables; Docker and Fly are expected not to, and are not measured.

## 8. Migration

One PR each, in this order; each leaves the product working. No compatibility layer, per the maintenance policy.

1. **Name** (built). The instance name from the configuration (`deploymentName`, `src/deploy/deployment-name.ts`); host resources, generated manifests and the storage claim use it, and `secrets`, `logs`, `destroy` and `login --deployment` take `--config` to say which instance. The default name is the program's (`package.json`'s), not the directory's, so an agent whose `package.json` name differs from its directory deploys under a new name; the manifests an earlier version wrote (`fly.toml`, `fastagent.compose.yml`, `agentcore.template.yaml`) are not read.
2. **Delivery** (built). The image holds the program only (the one build output left in `.fastagent/deploy/` is the program's
   package list); `FASTAGENT_CONFIG_JSON`, `FASTAGENT_NAME` and `FASTAGENT_RELEASE_ID` are rendered per host
   (`src/deploy/delivery.ts`); `delivered-text`, the `/etc/fastagent/` layer and the release manifest are gone; the box
   reads `FASTAGENT_CONFIG_JSON` (refused together with `FASTAGENT_CONFIG`); the pre-flight refuses what cannot be a
   variable and the host's limit (Railway 32768 characters; AgentCore 4096 bytes for the whole set, counting the
   runtime's own variables with its three parameter-set secrets at their most). Settled while building it:
   - The release id is a digest of the name and the configuration (§6), not a random value.
   - The value file's `FASTAGENT_MODEL` travels as the delivered configuration's `model` (laid over the file's own),
     rewritten whole at every deploy, so no stale variable outlives it on a host. Step 3 drops that source.
   - A generated manifest is the author's once written, so a changed configuration is in it only after `--force`,
     which resets the manifest's other settings; `--run` stops on the drift. A hand-edited manifest is changed by hand,
     the variable included.
   - Only `literalCredentials` of the *delivered* configuration are refused; the program's own `context.json` entries
     stay a warning, as they ship in the image like the code.
3. **Secrets** (built). `deploy` reads no default value file. Its values are the environment it runs in with the file
   `--env-file` names laid under it (`logs`, `destroy` and `login --deployment` the same, for the host account);
   `secrets push` has no default source (`--env-file` or `--from-env`); Docker's Compose file lists each declared secret by
   name (`OPENAI_API_KEY:`) and Compose fills it from the environment that runs it, `deploy --run` checks the names are
   set there without reading a value, and `secrets set docker` is gone (Docker is no longer a `secrets` host). The Agent API's
   key is made only at a terminal and shown once, kept nowhere (a CI job or a coding agent's run stops naming `secrets set
   <host> FASTAGENT_API_KEY --generate`); `invoke --url` takes `--key` or the environment. A production Feishu/Lark app a
   deploy makes keeps its credentials in the file `--env-file` names. The model is the configuration's only
   (`FASTAGENT_MODEL` in a file or the shell is read by no deploy). `FASTAGENT_ENVIRONMENT` stays: it still selects
   `.fastagent/dev` against `.fastagent/start` and the `.secrets/production/` credentials until step 5, and only `start`
   still reads `.secrets/production/.env`. The shell is now a source: a provider key exported where `deploy` runs is a
   value it was given and decides that the key travels, not a login on the box (the older rule kept the shell out); to
   deploy to a box that logs in, run without it.
4. **Local values.** `<agent>/.env` for `dev` and `start`; the scaffold, ignore rules and `.env.example` follow.
5. **Credentials.** The user-level layer; `.secrets/`, `keeps` and `FASTAGENT_SECRETS_DIR` go.
6. The user documents and agent-artifact.md §4.1 and §6 are rewritten for the new layout.

## 9. Not decided here

- A box's own writable configuration layer and editing it at run time ([agent-artifact.md](agent-artifact.md) §4.2).
- Whether an instance's MCP servers may expand every secret it was opened with (#997).
