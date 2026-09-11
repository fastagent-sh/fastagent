---
title: Configuration, deployment environments, and credential ownership
description: "Where each configuration fact lives and why: the convention boundary (FastAgent does not own deployment orchestration), the two tiers a single agent moves through, the three resolution chains, and what deliberately does not exist."
status: partially implemented
---

# Configuration, deployment environments, and credential ownership

**Status: partially implemented.** This is the design conclusion for [#482](https://github.com/fastagent-sh/fastagent/issues/482). It replaces that RFC's file layout and command surface with a smaller one; §11 lists what was dropped and why. The code truth is `src/`; §12 is the sequencing and carries what has landed.

**The day-one tier is built (steps 1–3). The env dimension (§2's day two, step 4) is not, and is deliberately not scheduled** — it is a pure addition with no demand behind it yet, so every `--env` sentence below describes a design that is ready rather than code that exists. §12 also lists the three day-one leftovers that are still open.

The user-facing document for what exists today is [configuration.md](../configuration.md).

## 1. Decision

Convention over configuration, with an explicit boundary:

> Conventions govern **what this agent is** — directory layout, declarations next to the code that needs them.
> They do **not** govern **who deploys what, where, and when** — that is orchestration, and it belongs to CI or a person.

Rails has environment conventions and never dictates whether you deploy with Capistrano or Kamal. FastAgent takes the same line: it must be **a command that is easy to orchestrate**, not an orchestrator. Everything that follows is derived from that boundary plus one observation about how agents actually grow (§2).

One misreading to avoid: a Rails environment is a *behavior mode* of one codebase (development reloads code, production eager-loads). A FastAgent `--env` is **only a naming dimension** and carries no behavior. If it ever carried behavior, definitions would start branching on it, which is where configuration drift begins.

## 2. Two tiers

> **Day one** — one instance, one personal subscription → **no env concept at all**; OAuth credentials travel automatically.
> **Day two** — several instances, provider API keys → env is a **pure addition**; credentials degrade into ordinary static variables.

These two arrive together, and not by coincidence: the hard requirement for several environments shows up in team/release settings, and that is exactly the setting that must stop using one person's coding-plan subscription (it dies when that person leaves). The consequence is the load-bearing simplification of this design: **the second tier introduces no credential machinery**, because a second environment's credential is an API key in its own `.env`.

That second tier is not a preference, it is what both providers ask for. OpenAI: "[the right way to authenticate automation is with an API key](https://learn.chatgpt.com/docs/auth/ci-cd-auth)"; carrying `auth.json` is documented as an advanced path for trusted private infrastructure. Anthropic goes further and makes it a term rather than a recommendation — subscription OAuth is "[intended exclusively for purchasers … to support ordinary use of Claude Code and other native Anthropic applications](https://code.claude.com/docs/en/legal-and-compliance)", third parties may not route requests through Free/Pro/Max credentials on behalf of their users, and the Agent SDK requires an API key.

## 3. Where each fact lives

Classify by what decides the **carrier**, not by whether the word "secret" appears in the name — that word bundles two different properties and is why the model took three attempts to place. Four questions:

1. **Where does the consumer run?** The `deploy` process on the builder, or the agent process on the box. A builder-local value needs no carrier at all.
2. **May it enter a readable artifact?** Image layers and committed files are readable by anyone who can pull or clone.
3. **Is it rewritten on the target?** Only a self-refreshing credential is.
4. **Who produces it?** This one decides whether *FastAgent* knows the answer to question 2. It knows for values it derives itself; it cannot know for values an author declares.

Questions 2 and 3 give four boxes, and **only three are inhabited**. Something both non-sensitive and rewritten on the target is not configuration at all — it is state, and it lives in `.state/`.

| Class | Definition | Carrier, and why only it | Members |
|---|---|---|---|
| **A. Builder-local** | The consumer is the `deploy` process itself | **None.** Delivering a value nothing reads only creates drift | `deploy.apt`, `deploy.agentcore.idleTimeoutSeconds`, the declared secret *names*, host location (AWS account/region, fly region), `http.host` (it describes a runtime, so putting it in committed config is the misplacement that gate exists for) |
| **B. Derived, non-sensitive** | FastAgent computes it and knows it is not sensitive | **Release manifest.** Rewritten by every deploy (cannot go stale), rides an immutable image (cannot go stale on the platform, cannot interpolate a shell), is JSON (no code-generation syntax to escape) | the resolved model, `releaseId`, the agent directory |
| **C. Authored application defaults** | In git, identical in every deployment | **The definition itself.** It already ships; a second copy would be a second truth | `model`, `thinkingLevel`, `http.port`, `selfSchedule`, `sessionControl` |
| **D. Operator-supplied environment values** | Differs per deployment, not in git, **sensitivity known only to the author** | **The platform's secret storage.** Must not enter a readable artifact, and must be rotatable on the target without rebuilding the image | channel secrets, provider API keys, `FASTAGENT_CONTROL_TOKEN`, anything a `{ secrets: […] }` declaration names, the secrets `deploy` mints (`FASTAGENT_WAKE_SECRET`, `FASTAGENT_INGRESS_SECRET`) |
| **E. Self-refreshing credentials** | The target rewrites it | Secret storage as a **seed**, the target's volume as the **authority** — the seed is written only when the target has none (`authSeedBytes`), because the target's copy is newer by definition | `auth.json` |

**D is treated as sensitive wholesale**, even though members like a `SLACK_DIGEST_CHANNEL` are not credentials. That follows from question 4: `{ secrets: […] }` declares "this value comes from the environment", not "this value is a credential", and FastAgent has no basis to guess. The cost is bounded and real (a runbook lists it as required, AgentCore makes it a `NoEcho` parameter so `describe-stacks` cannot show it). The escape hatch is a `sensitive: false` on the declaration, and it is not built until the diagnosability actually hurts — the framework must not guess.

Where a credential's **literal value** may appear follows from B/C versus D/E, and is absolute:

> Literal credentials exist in exactly two places: `.secrets/` (0700, gitignored, excluded from the image) and the platform's secret storage. **Every file inside the definition may only carry a reference**: `"$MY_API_KEY"` or `!command` in `models.json` (pi resolves both), and a declared name everywhere else.

That rule is advice to the author, and FastAgent can only report on it — which brings the executable form of question 4:

> **Gate what FastAgent causes. Warn about what the author chose.**

A `.dockerignore` that fails to exclude `.secrets/auth.json` **gates `--run`**: a packing rule of ours would put a credential in the image, and we can decide that with certainty. A literal `apiKey` in `models.json` only **warns**: the author wrote that string into their own committed file, and whether it is a credential is knowledge the framework does not have — pi's docs prescribe `"apiKey": "ollama"` for a keyless local server, and no static property separates that from a leaked key. (An endpoint's reachability is not one: `gw.example.com` may be internal DNS and `10.0.0.1` may be NAT-exposed.)

This is the rule §3's question 4 already implied, written as something a reviewer can apply. It was learned the expensive way: a gate built on "is this string sensitive?" took five rounds of patches enumerating private address ranges before the premise itself turned out to be undecidable.

## 4. Files

```
fastagent.config.ts               # in git (or .js/.mjs): name / model / http / selfSchedule / deploy.{secrets,apt}
persona.md  skills/  tools/  channels/  schedules/

.secrets/.env                     # the local (= single-instance deploy) values
.secrets/auth.json                # this project's OAuth credentials (login writes here by default)
.secrets/.env.example             # in git: the inventory of expected names

.secrets/production/.env          # day two only: that env's values (API key, AWS_REGION, FASTAGENT_MODEL…)
.secrets/alpha/.env

.state/                           # local state (no secrets)
~/.fastagent/.secrets/auth.json   # this person on this machine (login -g)
```

`.secrets/` keeps its 0700 guarantee (`ensureSecretsDir` in `src/paths.ts`), and its existing `*` ignore rule already covers every env subdirectory — git never descends into an ignored directory, so day two adds no ignore rule at all. **A single-instance agent has no `.secrets/<env>/` at all** — the acceptance test for convention over configuration is that a small agent never learns the word "env".

## 5. Three resolution chains, one rule

> **Fall back to a default. Never fall back to another environment.**

| Subject | Chain |
|---|---|
| Model | `--model` (local runs only) > the selected value file's `FASTAGENT_MODEL` > `config.model`. The operator's shell variable is not a source: the chain reads the value file, never `process.env` |
| Values | `--env` given → **only** `.secrets/<env>/.env`; omitted → `.secrets/.env`. No fallback between them |
| Credentials | `FASTAGENT_AUTH_PATH` > `.secrets/auth.json` > `~/.fastagent/.secrets/auth.json`, **per provider** — and only when the project path is the default one |

The defaults live in different places for exactly one reason: one can be committed and the other cannot. `config` is the committed application default; the global auth file is "this person's" default. **Another environment's values are never a default** — the local `.env` holds one person's values on one machine, so falling back to it would make a deployment's result depend on who ran it and where.

Two properties of the credential chain are not free choices, and both were paid for:

- **The fallback is per provider, not per file.** A file-level fallback would make every other provider in the global store vanish the instant `login anthropic` created a project `auth.json`.
- **An explicitly named path takes no second layer.** `FASTAGENT_AUTH_PATH` and `FASTAGENT_SECRETS_DIR` are instructions, not preferences (`resolveAuthFallback` in `src/engines/pi/config.ts`). The deployed artifacts set the third one, and a container must read its mounted credentials and nothing else — otherwise a fly/railway/agentcore box would quietly mount `$HOME/.fastagent/.secrets/auth.json` as a second layer.

`deploy` reads the project file only: the artifact is the truth, so a credential that exists only in the global store is not carried. `fastagent login` inside the agent directory, or `FASTAGENT_AUTH_PATH` naming the global file, are the two ways to hand it one — and the second makes one grant have two holders (§13).

Two rules follow:

- **Refresh writes back to the layer it read from.** Reading the global store and writing the project one would conjure a second holder of the same grant, which is the failure this whole area exists to avoid.
- **`--model` never enters a deployment** (a deployment must be reproducible). A remote model choice persists through the selected value file's `FASTAGENT_MODEL`. `modelTravelIssue` (`src/deploy/preflight.ts`) therefore disappears: there is no such thing as a model that "cannot reach the box", only a deployment with no source that resolves one.

## 6. CLI surface

```bash
fastagent login openai-codex          # writes <agent>/.secrets/auth.json
fastagent login openai-codex -g       # writes ~/.fastagent/.secrets/auth.json

fastagent deploy fly                  # plan + write the generated artifacts; touches nothing remote
fastagent deploy fly --run            # execute

fastagent deploy agentcore --env production --run
fastagent logs agentcore --env production
```

**Zero new commands, zero new config file formats.** The whole capability lands on three flags:

| Command | Change |
|---|---|
| `deploy <host> [dir]` | add `--env <name>`; drop `--model` (§5: it never reaches the box) and `--auth-path`; `host` stays a required positional (unambiguous, so it does not move) |
| `logs <host> [dir]` | add `--env <name>` |
| `login [provider]` | add `-g`; drop the `--auth-path` flag (the SDK's `authPath` option stays) |
| `dev`, `chat`, `info`, `invoke`, `fire`, `start` | drop the `--auth-path` flag; `FASTAGENT_AUTH_PATH` stays (§11) |
| the other six commands | unchanged |

`[dir]` is a positional both `deploy` and `logs` already carry, so `--env` is a flag rather than a second optional positional — `deploy fly production` and `deploy fly ./myagent` are indistinguishable otherwise. `deploy` without `--run` keeps its current meaning: it writes the generated artifacts into the agent dir (ownership markers decide what may be overwritten) and changes nothing on the host. Reading back remote state is **not** part of this proposal.

## 7. Deployment phases

Availability is a property of **ordering**, not of how many commands the operator runs.

```
1. preflight      source files, effective model + its provider, declared variables, account/region/names → print the plan
2. provision      storage and access; accepts no agent work yet
3. static values  the selected value file → the platform's variable storage
4. credential     credentials travel (§8); a failure stops here
5. readiness      the deployed process answers /health (no real model request)
6. activate       register webhooks, enable schedules, take traffic  ← the only point a public entrance opens
```

Step 5 is `publicHealthGate` (`src/deploy/channel-ingress.ts`), asked by the hosts whose public URL the platform mints — fly and railway — before they reach `registerWebhooks`: `fly deploy` and `railway up --ci` both exit 0 on a deployment that then crash-loops, and `setWebhook` does not verify that anything answers the URL. It is asked only when the deployment actually has a webhook to point; docker keeps probing the port it published locally, and agentcore its own runtime probe. It deliberately does not spend a real model call: it costs money and an unexpired access token **does not prove future refreshability**. A partial failure in step 3 is reported and stops the run — no success claim, no newly enabled scheduled work.

Step 4 needs no probe of its own, and `/health` must not grow a credential check. "A credential exists" is already guaranteed twice: `gateOnModelCredential` stops a `--run` with nothing to carry before the first side effect, and a failed seed write throws out of `maybeSeedAuth` on first boot, so the process never reaches a listening state. Re-deriving it inside `/health` would add no coverage and would let a healthy deployment whose key comes from a `models.json` `!command` be declared dead.

The point of the ordering is that a run with no usable credential **opens no entrance at all**, instead of reporting success and failing on the first real message.

## 8. Credentials

The existing mechanism is kept; only the surface around it is corrected.

- The payload is the **whole effective `auth.json`** (every provider). A deployed session can change its model (`src/engines/pi/session-settings.ts` treats model and thinking level as one setting), so trimming the payload to the currently effective provider would manufacture a "switch and it breaks" failure — and trimming it *correctly* would require the author to restate runtime intent, which is the new configuration dimension conventions exist to avoid.
- Delivery stays `FASTAGENT_AUTH_SEED` (chunked). A platform secret store is built for this. The real hazard — every deploy silently resetting the remote refresh chain — is already handled by `authSeedBytes(seed, fileExists)` in `src/deploy/secrets.ts`, which leaves an existing remote credential alone. **No per-host credential management API is introduced**; that was the single largest piece of implementation work in the RFC and its benefit does not hold up.
- A day-two environment's credential is `OPENAI_API_KEY` (or equivalent) in `.secrets/<env>/.env`: the ordinary static-variable path, **no special code**.
- Someone running several environments on OAuth anyway falls back to the project or global store (all envs share one person's subscription). That is **visible, not blocked**, and nothing is built for it:

```
target      production → agentcore  (123456789012 / ap-southeast-1)
model       openai-codex/gpt-6-astra   (source: .secrets/production/.env)
credential  openai-codex               (source: ~/.fastagent/.secrets/auth.json — the global store)
```

## 9. Variable delivery

```
the selected value file  →  validate/preview  →  the platform's variable storage  →  runtime env
```

No `secret push` / `env sync` prerequisite lifecycle (the lesson Kamal 2 encodes by deleting `envify`): edit the file, deploy. CI materializes the same file before running the same command.

**The selected value file is the only source. The environment running `deploy` is not consulted**, so there is no precedence rule to remember and no way for a deployment to carry a value that was written down nowhere. The industry splits on this exactly along the line of what the tool is configuring: dotenv never overrides an already-set variable and Compose lets the shell beat `env_file`, because both configure *this* process; Terraform checks `TF_VAR_*` **last**, after `terraform.tfvars`, because it declares a *remote* object; Kamal 2 goes furthest and stopped loading `.env` into the environment at all. A deployment is the second kind. CI supplies values the same way it supplies `auth.json` in OpenAI's own guide — by writing the file before running the command.

**Ownership is derived, not tracked remotely**: the keys FastAgent owns are every `{ secrets }` declaration ∪ the keys in the selected value file. Nothing outside that union is written, so platform-owned variables survive.

That union describes the *current* intent and cannot say which remote key a past deploy set, so **nothing is deleted implicitly** — and nothing outside it is reported either. What else lives in the platform's variable storage is the platform's business and the operator's: a tool that writes a subset has no standing to audit the rest, and saying "unmanaged" about a variable someone set on purpose is a warning with no action behind it. Tracking a "previously managed" set would need either a remote registry or local state CI does not have, and the whole point of §9 is that neither exists.

Values are redacted in every output; write-only platform secrets are never read back to build a plan; a plaintext value file never enters an image, a command-line argument, a generated manifest, or a log; framework-owned storage/ingress/bootstrap names are refused.

The real guard on missing values is the **declaration-driven gate** (`src/secrets-gate.ts`): a declared name with no value in the selected env fails and names the file that declared it. File existence is a fake guard; a declaration is a real one.

## 10. Isolation

Resource prefix `<name>-<env>` (`<name>` for a single instance), where `name` comes from `fastagent.config.ts` and is recorded once by `init` rather than recomputed from the checkout directory. State, schedules, services, and channel bindings all hang below it. Local `dev` is the same rule with no env, **not a special case**.

A distinct name is not a security boundary; platform permissions enforce the isolation. Generated host manifests keep their current home — the agent dir, with the marker line that makes them regenerable and a hand-tuned file untouchable (`src/deploy/container.ts`, [deploy.md](../deploy.md)) — because being committable and hand-adjustable is a deliberate property, not an accident. With `--env`, the host config carries the env in its name (`fly.production.toml`) so two environments do not overwrite each other's artifact.

## 11. Not doing

Dropped from the RFC, and from earlier drafts of this document:

| Rejected | Why |
|---|---|
| A binding record (`deploy.targets`) the tool writes into its own config | Buys only "type `--host fly` less often". Costs: programmatic TS rewriting; either an invisible local state (the "implicit current environment" the RFC rightly rejects) or a `deploy` that rewrites authored configuration rather than only regenerating its own marked artifacts. CI wants the flag spelled out anyway |
| `deploy.<env>.ts`, an env registry, a second config extension, config-merging DSL, env inheritance | Conventions must not require restating what a filename or a flag already says |
| `login --env`, `auth push`, per-host credential management, per-provider merge | Day two uses API keys; day one has no choice to make |
| A credential account/alias dimension, `config.accounts` | `--env` plus the two credential layers already covers "different account per environment" |
| Cross-env value fallback, importing pi's credentials, copying an OAuth grant between local and remote | §5 |
| Reporting remote variables outside the ownership union as **unmanaged** | §9: writing a subset gives no standing to audit the rest |
| Moving `.env` out of `.secrets/` | Plaintext credentials in a 0755 directory; see the `ensureSecretsDir` note in `AGENTS.md` |
| Removing `FASTAGENT_SECRETS_DIR` / `FASTAGENT_STATE_DIR` / `FASTAGENT_AUTH_PATH` | The fly/railway/agentcore plans point them at the mounted volume, and the deployed container locates `auth.json` through that chain. Only the corresponding CLI flags can go |
| A `--profile` selector, a current-environment switch, arbitrary credential-path options, a custom encryption/key-distribution framework | Orchestration or scope creep |
| Reading back deployed state to diff it, moving generated artifacts into `.state/`, narrowing `AGENT_CONFIG_NAMES` to `fastagent.config.ts` | None is needed for anything above, and each is unrelated to env or credential ownership |

## 12. Implementation sketch and sequencing

| Work | Where |
|---|---|
| `resolveEnvValues(agentDir, envName?)` → `{ envName, file, values }` | new `src/deploy/env-values.ts`; the **one** read, shared by the plan side and the run side |
| `loadEnvValues(file)` returning a Map and **not** writing `process.env` | `src/env.ts`. Loading a definition under a given env's values (channel/schedule discovery) runs in a **subprocess** — a module captures `process.env` at import time, and a subprocess is cheaper than inventing ESM cache invalidation |
| `name` field | `src/engines/pi/config.ts` |
| project > global credential fallback, refresh write-back to the layer read, `login -g` | `src/engines/pi/auth.ts`, `src/engines/pi/login.ts` |
| "credential present + ready" precondition | `src/deploy/registration-gate.ts` |
| report the effective model **and its source**; validate that model's provider; gate `--run` when **no** source resolves a model (the replacement for the deleted gate — without it the deletion leaves a silent-degradation window) | `src/deploy/preflight.ts` (delete `modelTravelIssue`) |
| carry the resolved model to the deployed environment | the release manifest (`DeploymentRelease.model` in `src/deploy/workspace.ts`), projected into `process.env` beside `FASTAGENT_AGENT` by `prepareStartWorkspace`. It is rewritten unconditionally by every deploy, so it cannot go stale, and nothing on the way in can interpolate the operator's shell. **Non-credential configuration only** — the manifest rides inside a readable image and is rebuilt every deploy, both of which are the opposite of what a credential needs (§8) |
| class D reads the **value file only** (§9), so `assembleSecrets` takes that Map instead of `env: NodeJS.ProcessEnv` | `src/deploy/secrets.ts` + `src/cli/commands/deploy/shared.ts`; every host's runbook then tells CI to write the file rather than export variables. Docker reaches it through Compose's own `env_file`, not per-name interpolation — interpolation resolves from the shell, the one source §9 excludes |
| a literal `apiKey` in `models.json` WARNS (§3: gate what we cause, warn what the author chose); a `$NAME` reference is an ordinary declared secret and belongs in the runbook's required list, not in `modelKeyInDefinition` | `src/engines/pi/models.ts` (`literalKeyProviders`) + `src/deploy/preflight.ts` |
| `.secrets/<env>/` path derivation | `src/paths.ts` |
| Per-env artifact names (`fly.<env>.toml`) under `--env` | `src/deploy/container.ts` + each host's `plan.ts` |
| Unchanged | `FASTAGENT_AUTH_SEED` + chunking + `collectAuthSeed` + `authSeedBytes`, `.secrets/` 0700, `secrets-gate`, `deploy.secrets` / `deploy.apt` |

| # | Step | Independent value | State |
|---|---|---|---|
| 1 | Deployment phase ordering: no entrance opens before credential + readiness | A correctness fix unrelated to env; worth having today | [#518](https://github.com/fastagent-sh/fastagent/pull/518) |
| 2 | One model chain (`FASTAGENT_MODEL` travels with the value file; delete `modelTravelIssue`) | All of day one; the single-instance path is unchanged | [#520](https://github.com/fastagent-sh/fastagent/pull/520) |
| 2b | class D reads the value file only — the same rule the model already follows | Removes the last path by which the builder's environment reaches a deployment | [#524](https://github.com/fastagent-sh/fastagent/pull/524) |
| 2c | literal-`apiKey` **warning** + `$NAME` references treated as declared secrets | Reports the second route by which a credential enters the image, without the framework deciding what is one | [#523](https://github.com/fastagent-sh/fastagent/pull/523) |
| 3 | Credential project > global fallback (per provider, refresh written back to the layer read) + `login -g` | One global login serves every project | [#525](https://github.com/fastagent-sh/fastagent/pull/525), [#526](https://github.com/fastagent-sh/fastagent/pull/526) |
| 4 | The env addition: `--env` + `.secrets/<env>/.env` + `<name>-<env>` prefix, and `config.name` with it | Pure addition; day-two capability | **not scheduled** — no demand yet |

Each step is usable on its own and is its own PR. 1 and 3 are small, 2 and 4 are medium.

`config.name` moved from step 2 to step 4: its only consumer is the `<name>-<env>` prefix, so on its own it is a config field nothing reads.

### Still open from day one

One item is outside every step above, and it blocks nothing:

| Left | Where it is written | Why it is still open |
|---|---|---|
| Every supported host has an end-to-end check | §14 | `test/live/` probes exist, but no host is covered end to end |

## 13. Known costs

- **`--host` is typed every time.** Bought with zero binding machinery and a more explicit CI command.
- **"Which account does prod use" is not in committed FastAgent config.** The review point moves to the CI workflow, which also has branch protection and environment protection rules — a better home for it.
- **Local and remote hold the same OAuth grant, which both providers rotate.** Verified in pi's flows (`auth/oauth/anthropic.js`, `auth/oauth/openai-codex.js`): every refresh returns a new refresh token. OpenAI's [CI/CD auth guide](https://learn.chatgpt.com/docs/auth/ci-cd-auth) says to use one `auth.json` "per runner or per serialized workflow stream" and lists "another machine or concurrent job rotated the token first" as a reason to reseed. So a deployment running on the same grant as the developer's machine is a posture both providers advise against, and the only tools available are not overwriting implicitly (`authSeedBytes`, which is exactly the "seed only if missing" rule that guide calls the critical detail) and reporting the source. `proper-lockfile` makes concurrent refreshes safe *within one filesystem* only.
- **The deployed box never writes its refreshed `auth.json` back.** OpenAI's ephemeral-runner pattern requires a round trip (restore → run → persist the refreshed file). Hosts with a persistent volume behave like their "persistent runner" case and are fine; **AgentCore is the ephemeral case without the write-back**, so every runtime version update returns to the seed, which by then may already have been rotated away. Use an API key there.
- **`FASTAGENT_AUTH_SEED` chunking is ugly but effective**, and `auth.json` keeps growing with providers.
- **Loading a definition under a given env's values costs a subprocess.** Every plan/deploy pays one process start, and channel/schedule discovery errors have to cross a process boundary without losing their diagnosability (§12).
- **A refresh and a storage write are not one transaction.** A crash after provider-side rotation can still require reauthentication, and each provider's grant issue/invalidate behavior must be verified rather than assumed.
- **AgentCore resets its storage on every runtime version update**, so OAuth credentials are re-delivered on each deploy. That scenario should use an API key; no special-case clause is written for it.

## 14. Acceptance

Checked boxes are covered by a test in the offline suite. The unchecked ones are either day two (`--env`) or need a real host.

- [ ] A freshly generated small agent never encounters the env concept; `fastagent deploy fly --run` works end to end.
- [ ] `.secrets/production/.env` and `.secrets/alpha/.env` can select different models; preflight, generated configuration, runtime, and diagnostics agree on the effective model and its credential provider.
- [ ] With `--env`, neither `.secrets/.env` nor the operator's shell `FASTAGENT_MODEL` affects resolution.
- [ ] A typoed env or a missing declared variable fails visibly and names the declaring file, with no other environment's values substituted.
- [ ] A deploy delivers the full allowed key set, reports partial failure, and deletes no remote key implicitly.
- [ ] Value files, secret values, and credentials appear in no build context, image, manifest, command argument, or log.
- [x] With no project credential, the global one is used and its source is printed; a credential read from the global store refreshes back into it and leaves no project copy.
- [x] Concurrent local projects share the global credential file safely.
- [x] With no usable credential, **no public entrance is activated**; a redeploy against a host that already holds one does not overwrite it.
- [ ] Redeploy, rollback, restart, and session-snapshot restore all preserve the latest credentials.
- [ ] Every supported host has an end-to-end check for the above; unsupported capability combinations fail explicitly.
