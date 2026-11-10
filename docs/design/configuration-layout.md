---
title: Where configuration, secrets and credentials live
description: "Why an instance has so many places for values today, and the layout that replaces them: configuration by what a value is, secrets in the platform's store, one `.env` for local work, credentials in the instance's state."
type: design-doc
status: proposed
---

# Where configuration, secrets and credentials live

**Status: proposed.** Nothing here is built. It replaces [configuration.md](configuration.md) §3 to §6 and §9, and the
value-file parts of [agent-artifact.md](agent-artifact.md) §4.1 and §6.2, once accepted. The code is `src/`.

## 1. The problem

The same kind of value lives in several places, each with its own directory, variable or flag (the table counts them).
This is not one decision; it is the sum of cases each solved by adding a place, with none retired.

| What | Places today |
|---|---|
| Values that become the environment | `<agent>/.secrets/.env` (dev), `<agent>/.secrets/production/.env`, `--env-file`, `FASTAGENT_SECRETS_DIR/.env`, the process environment, and a bare `<agent>/.env` that is not read but is warned about |
| Model credentials (`auth.json`, `device.json`) | `<agent>/.secrets/`, `~/.fastagent/.secrets/auth.json` (`login -g`), `FASTAGENT_AUTH_PATH`, `FASTAGENT_SECRETS_DIR`, and `<root>/.state/` for an app |
| MCP grants (`mcp-auth.json`) | `<agent>/.secrets/` for the CLI, `<root>/.state/` for an app (`keeps: "secrets" \| "state"` in `openServing`) |
| Instance state and working directory | `.fastagent/dev/`, `.fastagent/start/`, `--root`, `--state`, `--workdir`, `FASTAGENT_ROOT`, `FASTAGENT_STATE_DIR`, `FASTAGENT_WORKDIR`, `/data`, `/mnt/data` |
| Instance configuration | the project's `fastagent.json` (dev), `--config`, `FASTAGENT_CONFIG`, `/etc/fastagent/fastagent.json` (image), `<root>/fastagent.json` (an app) |

Why it grew, from the history and the docs:

- **The CLI is anchored to the project, an app to the instance.** `.secrets/` is a directory of the project; an app has
  no such directory, so `openServing` grew `keeps` and a second set of paths. Two anchors, two layouts.
- **Each target added a way to move a directory.** A container needs its volume (`FASTAGENT_STATE_DIR`,
  `FASTAGENT_SECRETS_DIR`, `FASTAGENT_AUTH_PATH`, #280, #306, #496); a second environment added `.secrets/production/`
  (#769). Each is a path override for the same file.
- **The documentation says so itself.** configuration.md: "What stays in the project for now: `.secrets/`. They move
  into the instance with the deploy layout in a later release."
- **One directory holds three things with different conventions.** `.secrets/` has environment files (the convention is
  a `.env` at the project root, ignored by git; Next.js now generates a project that ignores every `.env*`), credential
  state that a tool rewrites (the convention is the tool's own directory), and a template that is committed.
- **Non-secret deployment values sit in a file named for secrets.** `deploy` reads `FASTAGENT_MODEL` and `GITHUB_TOKEN`
  from `.secrets/production/.env`. A CI job has no such file, and the convention it follows (Fly's `fly.toml [env]`,
  Wrangler's `vars`, twelve-factor) is that non-secret configuration is committed and secrets are injected from the CI's
  store into the target. The design said "a deployment's values are the target's state" (agent-artifact.md §6.2), and
  the code did not follow it.

## 2. The rule

A value is placed by what it is, not by which environment it is for.

| Kind | Example | Lives in | Committed |
|---|---|---|---|
| The program | prompt, skills, code, defaults, `context.json` | the definition | yes |
| A deployment's non-secret configuration | `model`, `thinkingLevel`, `http.*`, `channels.<name>.ingress`, `settings`, content, MCP servers | a configuration file given to `deploy --config`, one per environment (`prod.json`, `staging.json`) | yes |
| A secret | provider key, channel token, `GITHUB_TOKEN` | the target's own secret store, set by `fastagent secrets` or by the CI's secret step | never |
| A value for local work | the same secrets, on one machine | `<agent>/.env` | never |
| Credential state a tool writes and refreshes | `auth.json`, `device.json`, MCP grants | the instance's `.state/`, or the user's `~/.fastagent/` | never |
| Per-instance state | sessions, channel state, clones | the instance root | never |

Consequences:

1. **`deploy` reads no value file.** It decides with the program's defaults and the configuration it is given. A CI job
   writes the configuration into the repository, or passes `--config`, and sets secrets with `secrets push --from-env`
   (already built), which reads the CI's environment. The model, the Agent API switch and the public URL are
   configuration, so they are written there; the four `FASTAGENT_*` variables of the previous change affect only what a
   command runs locally.
2. **There is no production environment file.** A person who keeps one names it as they like (`.env.production`,
   `.production.env`), ignores it, and gives it to the command that needs it: `secrets push --env-file`, or
   `start --env-file`. FastAgent never looks for it. `.secrets/production/` and `FASTAGENT_ENVIRONMENT` go.
3. **`dev` and the commands that run the agent in the project read `<agent>/.env`.** It is the file habit puts there, the
   scaffold's ignore rules already cover it, and the warning that it is not read goes away. `start` and a deployed box
   read the process environment and `--env-file` only.
4. **Credential state moves out of `.secrets/`.** It is state a tool rewrites, so it is the instance's: `.state/auth.json`,
   `.state/mcp-auth.json` (an app already keeps both there). One layer above it stays, the user's `~/.fastagent/auth.json`
   (`login -g`). `keeps` in `openServing` and the project-level `auth.json` layer go; `FASTAGENT_SECRETS_DIR` goes.
   `AgentCore` already puts its secrets inside the state root (#306), so it loses a special case.
5. **`.secrets/` disappears.** The scaffold writes no `.secrets/`, and the committed template becomes `.env.example` at the
   root.

## 3. What each place becomes

| Today | After |
|---|---|
| `<agent>/.secrets/.env` | `<agent>/.env` |
| `<agent>/.secrets/production/.env`, `FASTAGENT_ENVIRONMENT` | removed; any file through `--env-file` |
| `FASTAGENT_SECRETS_DIR` | removed |
| `<agent>/.secrets/auth.json`, `device.json`, `mcp-auth.json` | `<root>/.state/` |
| `~/.fastagent/.secrets/auth.json` | `~/.fastagent/auth.json` (the name `.secrets` goes with the directory) |
| `FASTAGENT_AUTH_PATH` | kept, for a credential file kept elsewhere (a mounted secret) |
| `FASTAGENT_ROOT`, `FASTAGENT_STATE_DIR`, `FASTAGENT_WORKDIR`, `--root`, `--state`, `--workdir` | unchanged: where an instance is |
| `FASTAGENT_CONFIG`, `--config`, `fastagent.json` | unchanged for a local instance; a deployment's file is the one given to `deploy --config` |
| `deploy` reading `FASTAGENT_MODEL`, `GITHUB_TOKEN`, `FASTAGENT_API_KEY` from a value file | `model` in the delivered configuration; `GITHUB_TOKEN` and the API key are secrets, held by the target |
| Docker's `env_file:` pointing at `.secrets/production/.env` | the target store for Docker, see §5 |

## 4. How a deployment gets what it needs

| Step | Who | Where |
|---|---|---|
| Write non-secret configuration | the author | a file in the repository, `deploy --config <file>` |
| Set secrets | the author, or the CI | `fastagent secrets set\|push <host>`; in CI `secrets push <host> --from-env` |
| Deploy | the author, or the CI | `fastagent deploy <host> --config <file> --run` |
| Model sign-in that is not a key | the author, once, on the box | `fastagent login --deployment <host>`, written to the box's `.state/` |

`deploy` checks that every declared secret name is held by the target and stops before building when one is not
(already built). Nothing it reads is a secret value, so nothing in its process, output or image is.

## 5. Open questions

These decide the migration and are not decided here.

1. **Docker's store.** Compose reads `env_file:`, and `secrets set docker` needs a file the author does not edit. The
   candidate is a file under `.fastagent/deploy/` (FastAgent's own directory, ignored by git, already left out of every
   image), mode 0600. The alternative is no file: `secrets set docker` is refused and Docker takes secrets from the
   shell running Compose, which is Compose's own convention.
2. **A project-level credential layer.** Today a `login` in a project is shared by `dev` and `start` through
   `<agent>/.secrets/auth.json`. With credentials in the instance's `.state/`, `dev` (`.fastagent/dev/.state`) and
   `start` (`.fastagent/start/.state`) each log in separately, or `login -g` is used. If sharing matters, the layer
   stays, in a directory of its own that is not named for secrets.
3. **Should `start` read `<agent>/.env`?** It is the trial of the production build on a machine; reading the development
   file would make a trial depend on development values, which is why `start` reads none. A person who wants values runs
   `start --env-file <file>`.
4. **`FASTAGENT_MODEL` in CI.** With `model` in the delivered configuration the problem the pre-flight's note describes
   disappears for a deploy. A box that must change its model without a redeploy sets the variable on the platform, which
   outranks the configuration (unchanged).

## 6. Migration

One PR each, in this order; each leaves the product working.

1. `deploy` reads no value file: `model` and the rest come from the program and `--config`. The previous change's
   production-file reading of the four variables is already withdrawn.
2. `<agent>/.env` for local commands; the scaffold, ignore rules, the stray-file warning and `.env.example` follow.
3. Credential state into `<root>/.state/`; `keeps`, the project layer (per open question 2) and `FASTAGENT_SECRETS_DIR`
   go; the deploy plans (`/data/.secrets`, the AgentCore secrets path) lose their special cases.
4. `.secrets/production/` and `FASTAGENT_ENVIRONMENT` go; Docker's store per open question 1.
5. The two documents this supersedes are rewritten, not patched.

No compatibility layer, per the maintenance policy; the scaffold's next version writes the new layout, and an agent
that has the old one is told where each file moved when it starts.

## 7. Not decided here

- The configuration the deployed box layers over what it was delivered, how a box's configuration is edited at run time,
  and delivering configuration as a release input of its own instead of an image layer: [agent-artifact.md](agent-artifact.md)
  §4.2 records them, and they need each host's limits first (AgentCore allows 4 KB of environment variables in all).
- Whether an instance's MCP servers may expand every secret it was opened with (#997).
