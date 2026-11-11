---
title: Channels across environments
description: "Independent dev and production apps, credentials and onboarding state; deploy provisions the production Feishu/Lark app."
type: design-doc
status: implemented
updated: 2026-10-09
---

# Channels across environments

**Status: implemented for dev and production.** Its §3 and §4 are superseded by [channel-setup.md](channel-setup.md) (implemented): `add` changes the program, and a
platform app is set up per instance by `channels setup`. An agent directory has one definition and two independent
runtime environments. Staging and multiple production deployments are not selected by this mechanism.

## 1. The boundary

A platform app receives at one place: a Telegram webhook URL, a Slack Request URL, or a Feishu/Lark subscription
mode and Request URL. Two environments must use different apps to receive independently. Two WebSocket clients
on one Feishu app split its events; changing its subscription mode affects every client of that app.

| Command | Value file | Local state | Feishu/Lark default |
|---|---|---|---|
| `dev`, `add <channel>` | `.secrets/.env` | `.state` | WebSocket |
| `start`, `add <channel> --env production` | `.secrets/production/.env` | `.state/production` | webhook |
| `deploy <host>` | none: the environment it runs in, and the file `--env-file` names | (the host's) | webhook |

The files are complete environments, not overlays. A missing production file is empty; dev credentials,
provider keys, proxy settings and other values are never copied or inherited from the dev file. Production keys
must be supplied explicitly. `deploy` reads only production values, `fastagent secrets push` takes the production file unless `--env-file` or
`--from-env` name another source, and a deployment never gets the builder's stored login.

`FASTAGENT_ENVIRONMENT` communicates the command's selection across installed package copies and a dev worker.
It is command-owned and never carried as an operator-supplied deploy secret. Explicit `FASTAGENT_SECRETS_DIR`,
`FASTAGENT_STATE_DIR` and `FASTAGENT_AUTH_PATH` still override the respective paths; an operator using overrides
must keep the environments separate. Generated hosts pin their own persistent-storage paths.

Both environments' secrets remain ignored by git and excluded from the image. Preflight checks the whole
`.secrets` tree, including dev credentials, when an operator keeps an ignore file.

## 2. The ingress is the instance's configuration

One channel file offers both ways, `byIngress({ webhook, connection })`, and each instance's configuration chooses:

- `channels.<name>.ingress` in the instance's `fastagent.json` is `"webhook"` or `"connection"` (a connection the channel opens: Feishu's and Lark's long connection); a name the agent has
  no channel by is refused.
- Unset means webhook; `dev` (which marks its process `FASTAGENT_DEV=1`) means WebSocket. A deployment receives by
  webhook because a host that scales to zero (AgentCore today; Fly Sprites, Railway Serverless, Cloudflare's Durable
  Objects) wakes on an inbound request, and a long connection either keeps it awake or dies when it sleeps.
  WebSocket is for a process that stays up without a public URL: `dev`, or a machine of one's own.
- `add --ingress` writes the development instance's `fastagent.json`, or the file `--config` names; a deployment's
  is the configuration `deploy --config` delivers, so the development instance's choice never changes production.
- Webhook declares App ID, Secret and Verification Token. WebSocket declares only App ID and Secret. An instance is
  asked only for its way's.
- AgentCore refuses WebSocket; the other hosts keep a resident process for it.
- `deploy` reads the way from the configuration it delivers, as the box will, never from the environment.

A file that names one factory receives that way only: a configuration naming the other way is refused at open, and
`channels setup --ingress` refuses it before touching the app. Re-scaffold it to offer both.

## 3. Deploy provisions the production app

Interactive `deploy --run` runs `channels setup` for the production instance when a declared Feishu/Lark channel lacks its
production App ID, Secret, or webhook Verification Token. A complete app is reused without another creation flow.
This also applies to a production environment explicitly configured for WebSocket.

1. Run preflight and host validation before creating an app. AgentCore rejects long connections and names beyond
   its resource-name limit. Refuse missing values that setup cannot supply.
2. Refuse unattended setup (`--no-input` or no terminal), naming the missing production values. A deployment has no
   default file, so setup keeps its credentials in the file `--env-file` names: without one the deploy stops naming
   `channels setup <kind> --env-file <file>`, and a deploy that is given the file makes the app there. CI supplies the
   values in its environment beforehand. Generate-only deployment creates no remote app.
3. **Feishu:** scan-to-create a separate production app. A webhook app requests the agent scopes plus
   `application:application:patch` at creation. Persist App ID and Secret immediately, before token capture;
   a tenant approval delay or interrupted setup resumes the same app on the next run.
4. **Lark:** guide creation and credential entry in the international console. When its config API returns 404,
   mode, token and Request URL configuration remain manual.
5. Capture the Verification Token with the existing temporary-tunnel flow and persist it to the production file.
   A withheld scope stops completion visibly. Tenant approval and version publishing remain console actions.
6. Re-run preflight and host validation, then build and deploy with the values now in that file. Once readiness and model login pass,
   register the deployment's stable Request URL with those same values, never shell-exported dev credentials.

Nothing refuses a production App ID that is the dev one: two instances on one app are documented, as for Telegram and
Slack (an app is one receiver, so copying a complete dev file into production takes dev's events away). `channels setup`
for another instance creates a new app (Feishu) or asks for another app's credentials (Lark).

Docker's generated Compose lists the secrets by name, and Compose fills them from the environment that runs it. It has no
public URL of its own, so a deployment with a webhook channel is an operator with their own ingress: they supply app
values and name the URL as `http.publicUrl` (or set the channel to `connection`).

## 4. Other channels

A production Slack app or Telegram bot is another instance's: `channels setup <name> --config prod.json --env-file
prod.env` creates it (a Slack app from the manifest link, a bot through BotFather) and keeps its
credentials in that file, with a webhook's secret made once. Neither channel is automatically provisioned by `deploy`,
and no credential of the person's own (Slack's configuration token) is kept anywhere.

`dev --tunnel` registers only the dev app, and `deploy --run` registers only the production app. Re-registering
one app can still move that app between URLs, but it no longer takes messages from the other environment's app.
