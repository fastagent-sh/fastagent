---
title: Configuration, deployment, and credential ownership
description: "The convention boundary (FastAgent does not own deployment orchestration), the order a deployment follows, and why a model credential is created on the deployment and never carried. Where values live is configuration-layout.md."
status: current
---

# Configuration, deployment, and credential ownership

This is the design conclusion for [#482](https://github.com/fastagent-sh/fastagent/issues/482), cut to what still holds. Where
configuration, secrets and credentials live is [configuration-layout.md](configuration-layout.md); the user-facing
document for what exists today is [configuration.md](../configuration.md). The code truth is `src/`.

## 1. Decision

Convention over configuration, with an explicit boundary:

> Conventions govern **what this agent is** — directory layout, declarations next to the code that needs them.
> They do **not** govern **who deploys what, where, and when** — that is orchestration, and it belongs to CI or a person.

Rails has environment conventions and never dictates whether you deploy with Capistrano or Kamal. FastAgent takes the same line: it must be **a command that is easy to orchestrate**, not an orchestrator. Everything that follows is derived from that boundary.

## 2. Deployment phases

Availability is a property of **ordering**, not of how many commands the operator runs.

```
1. preflight      source files, effective model + its provider, declared variables, account/region/names → print the plan
2. provision      storage and access; accepts no agent work yet
3. secrets        the declared names the target holds are checked; none is read or carried
4. readiness      the deployed process answers /health (no real model request)
5. credential     the box logs in itself, unless it already holds one (§3); a failure stops here
6. activate       register webhooks, enable schedules, take traffic  ← the only point a public entrance opens
```

Step 4 is `publicHealthGate` (`src/deploy/channel-ingress.ts`), asked by the hosts whose public URL the platform mints — fly and railway — before they reach `registerWebhooks`: `fly deploy` and `railway up --ci` both exit 0 on a deployment that then crash-loops, and `setWebhook` does not verify that anything answers the URL. It is asked only when the deployment actually has a webhook to point or a login on the box follows (the login runs the CLI the box installs on its first boot); docker keeps probing the port it published locally, and agentcore its own runtime probe. It deliberately does not spend a real model call: it costs money and an unexpired access token **does not prove future refreshability**. A declared secret the target lacks stops the run at step 3 before anything is built — no success claim, no newly enabled scheduled work.

Step 5 needs no probe of its own, and `/health` must not grow a credential check. The login reports its own outcome as one result line from the box (a credential for the provider now exists there, or not), and without a terminal to run it in, `--run` stops right there with the command to run. Re-deriving it inside `/health` would add no coverage and would let a healthy deployment whose key a provider in its code resolves itself be declared dead.

The point of the ordering is that a run with no usable credential **registers no webhook**, instead of reporting success and failing on the first real message. What the box starts by itself is not gated: a long-connection channel connects and the resident scheduler runs from boot, so on a host that stays up without a login (a first `--run` from CI) those turns fail until someone logs the box in. The alternative, holding them back until a credential exists, would put a credential check in the serving path, which step 5 rules out.

## 3. Credentials

A credential that is a variable (a provider API key, set on the target by `fastagent secrets`) is a secret and needs nothing here. Every other one is **created on the deployment**, never carried:

- `fastagent login --deployment <host>` runs the ordinary login on the box, through the host's own owner-authenticated shell (`docker compose exec`, `fly ssh console`, `railway ssh`, AgentCore's `InvokeAgentRuntimeCommandShell`). The owner's terminal renders it and opens the browser; the box holds the PKCE verifier, exchanges the code, and writes its own `auth.json`. The box is then the only holder of its grant, so neither side can log the other out, and logging in again replaces it. The mechanism is in [core.md](core.md) §9.
- `deploy --run` starts that login after readiness and before activation (§2), for the model's provider, keeping a credential the box already holds, so a redeploy leaves it alone. Without a terminal it stops with `not logged in` and the command to run: a CI run never reports success for an agent that cannot answer.
- A box whose credential is missing or rejected later (revoked, a lost volume) names `fastagent login --deployment <host>` in its startup report, its host filled in where the platform's environment says it (`deployedHost`).
- **Two questions, two owners.** The builder decides only what the deploy ships (`credentialRoute` in `src/deploy/preflight.ts`): a key the definition references travels as a secret the target holds; otherwise the box is asked. It never asks what authenticates the model on the builder's machine — its stored logins and the shell running deploy do not travel, and every earlier attempt to infer the box from them was wrong in a new way. Whether the box authenticates, and with what, is the box's own answer, the same function its startup report uses (`AgentModels.authStatus`), because only the box knows what it has stored, which platform variables it was given, or what role it runs as.
- **A stored login outranks a key** (pi's rule: a stored credential owns its provider). A key set on the target after the box logged in is therefore unused; the box's startup report says so and names the switch (log in with the key), rather than deploy deleting a login on the owner's behalf.
- **AgentCore** resets its storage on every deploy and after 14 idle days, and the login with it, so every deploy of an agent that logs in ends with that login. The old grant goes with the old storage, so the new one is again the only holder. Without a terminal the outcome is known before anything is built (nobody can redo the login), so `--run` gates there instead of replacing a serving runtime with a logged-out one.

Why not carry a copy of the local `auth.json`: one grant would have two holders that each refresh it, so a provider that rotates refresh tokens (both pi's OAuth providers do) logs out whichever refreshes second, and a copy written only when the box has none cannot replace a dead one.
