# Changelog

All notable changes to `@kid7st/fastagent` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the project is pre-1.0, minor versions may include breaking changes.

## [Unreleased]

### Added

- **`fastagent deploy fly` — host-scoped deploy artifact + runbook generation.** Computes `fly.toml`
  (`auto_stop_machines="suspend"` + `min_machines_running=0`, or `1` when a github channel is present —
  github turns have no replay — + a `/data` volume mounted as `FASTAGENT_STATE_DIR`), `Dockerfile`, and
  `.dockerignore` from the resolved definition, then prints
  an ordered flyctl runbook — `fly apps/volumes/secrets/deploy` with the exact secret list (model auth
  + discovered channels) and the post-deploy webhook step. It does **not** run flyctl: cloud-neutral by
  design, fastagent owns the two ends it uniquely knows (definition-aware artifacts; webhook
  registration) and hands the middle to a coding agent (or you) to execute. Autostop is a Fly headline
  feature, so one-shot generation flags shape it: `--stop` (stop instead of suspend), `--no-scale-to-zero`
  (keep one machine up); fly.toml stays the single source (a kept one wins — the flags only shape a fresh
  or `--force`d file). `--force` overwrites existing artifacts (else kept). Single-machine tier (one
  volume, one machine); the runbook says so.

- **Acknowledgements + npm metadata.** README now credits the open-source stack it builds on — pi
  (the reference engine) and the libraries it depends on — with a "built with pi" badge. `package.json` gains `homepage`, `bugs`, and `author`. All runtime
  dependencies are MIT and are not bundled, so no third-party license ships in this package's tarball;
  the one vendored asset (the `writing-great-skills` skill) already includes its license.
- **First-run model picker.** A scaffolded workspace no longer hard-codes a model. When no model is
  set (flag/`FASTAGENT_MODEL`/config) and a serving command (`dev` / `start` / `invoke`) runs in a
  terminal, FastAgent lists the models of the providers you are logged into (`Models.getAuth` — stored
  login or env key) and writes your pick back to the config so the next run is silent. Non-interactive
  runs (CI, a container) skip the prompt and fail with the clear `missing model` error, unchanged. This
  removes the old default (`openai-codex/gpt-5.5`) that gated first-run on one specific paid
  subscription — onboarding now adapts to whatever provider you actually authenticated.

### Removed

- **Tightened the public API surface** (pre-1.0 cleanup, `src/index.ts`): dropped exports that
  reference no public signature and only leak engine internals — `scaffoldWorkspace` / `ScaffoldResult`
  (the `init` implementation, CLI-internal), `piBasePrompt` / `piDefaultTools` (engine assets), and
  `loadAgentDefinition` / `LoadAgentDefinitionOptions` (the standalone loader; the ladder rungs own
  loading). `LoadedDefinition` and `SkillCollision` stay — they are load-bearing on the
  `createPiAgentFrom*` return surface. **Upgrading:** for custom wiring/tests, import these from their
  modules directly (`./engines/pi/create.ts`, `./engines/pi/definition.ts`, `./scaffold/init.ts`)
  instead of the package root.

### Changed

- **`init` now scaffolds a minimal self-iterating agent.** A fresh workspace is `AGENTS.md` (a
  short persona built around self-improvement — the folder is the agent, re-read every turn, so it
  can edit its own definition and skills), the `writing-great-skills` example skill (vendored
  verbatim from [mattpocock/skills](https://github.com/mattpocock/skills), MIT, `LICENSE`
  included — the guide to authoring skills), and a `fetch-url` example code tool. Everything is
  written offline. `--minimal` keeps AGENTS.md + the skill + config (dropping the tool and
  `package.json`); `--no-install` scaffolds everything but skips `npm install`. Replaces the
  earlier example templates (a `house-style` skill, a `word-count` tool).
- **`vendorSkill` (and `add skill`) now guards the `skills/` path**: a symlink escaping the
  workspace or a plain file named `skills` fails with one clear error instead of writing outside
  the workspace or emitting per-write noise.

## [0.9.0] - 2026-07-05

### Changed

- **BREAKING: the channel contract is now `ChannelModule = (ctx: ChannelContext) => Routes`** with
  `ctx = { agent, stateRoot }`, and the bundled adapters are policy-only factories:
  `telegramChannel(opts)` / `githubChannel(opts)` take options (no `agent` argument) and RETURN a
  `ChannelModule` that mounts their route (`POST /telegram`, `POST /webhook`). A scaffolded channel
  file is now one policy expression — `export default telegramChannel({…})` — and `agent`/`stateRoot`
  flow from the framework to the adapter without transiting user glue. This also fixes a real anchor
  bug: telegram state was rooted at `process.cwd()/.fastagent` while engine state used
  `<dir>/.fastagent`, so `fastagent start <dir>` from elsewhere split the state home. The
  `TelegramChannelOptions.stateDir` option is removed: the channel home is always derived from the
  state root, so glue can never silently bypass the operator's one state knob.
  **Upgrading:** rewrite `channels/*.ts` to the new one-expression shape (or re-run
  `fastagent add <kind>`); if you ran `fastagent start <dir>` with a cwd other than `<dir>` (or used
  the removed `stateDir` option), move the old telegram state —
  `<old cwd>/.fastagent/channels/telegram/` → `<state root>/channels/telegram/` — before starting,
  or pending turn intents and group-context buffers are silently abandoned.

### Added

- **`FASTAGENT_STATE_DIR` — one knob for the whole machine-state home.** `.fastagent/` is now formally
  the agent's single-lifecycle state root (sessions, `auth.json`, `channels/<kind>/`); the opener
  resolves `FASTAGENT_STATE_DIR` > `<dir>/.fastagent` once and everything derives from it, so a
  container mounts ONE volume to keep all durable state (including the Telegram turn intents and
  context buffers that crash/deploy replay depends on — previously impossible to relocate). The finer
  `--sessions-dir`/`FASTAGENT_SESSIONS_DIR` and `--auth-path`/`FASTAGENT_AUTH_PATH` knobs still
  override their specific path on top (as operator knobs, a relative value resolves against cwd). The
  self-ignore leak guard is now root-based: a custom in-tree root (a `FASTAGENT_STATE_DIR` inside the
  agent dir) gets its own `.gitignore="*"`, closing a gap where credentials under a non-`.fastagent`
  in-tree root could show as committable.

- **Durable turn intent for the Telegram channel (L1 crash/deploy recovery).** An accepted turn's
  intent is now persisted before the webhook ACK (`turns.json`) and removed when the turn ends; a turn
  interrupted mid-run — by a crash *or* a SIGTERM deploy (`start` has no graceful drain) — is replayed
  on the next start, recovering the ACKed-but-unfinished window Telegram won't redeliver. This is
  **at-least-once**: replay re-runs the whole turn, so side-effecting tools re-run (safe for a Q&A bot;
  the bar for adding side-effecting ones), and a turn repeatedly interrupted mid-run is dropped after a
  few attempts with a notice to the asker. Exactly-once delivery and deterministic step-replay remain
  L2 (a K-axis backend). This is a deliberate reversal of 0.8.3's "accept the loss" stance — a
  per-process *intent* log made cheap by the channel's existing atomic-rename state primitive, distinct
  from the queue-level WAL 0.8.3 removed.

## [0.8.3] - 2026-07-05

### Changed

- **The telegram per-session turn queue is now in-memory** (was a file-backed WAL). One turn at a
  time per session (FIFO) is unchanged — it always was; only the restart-durability layer is
  removed. Rationale: the queue is the group-UX serializer atop the engine lease, and Telegram
  already redelivers *never-ACKed* updates on its own; the one window a WAL added was an
  *ACKed-but-unfinished* turn lost to a crash, which a single-process bot accepts (the asker
  re-asks) — recovering it is durable-execution work for a K-axis backend (an external queue with
  distributed-locking recovery), not a hand-rolled per-process log in the channel. This makes turn
  durability consistent with `start`'s existing no-graceful-drain on SIGTERM. The un-summoned group
  context buffer stays durable (its case is stronger — those messages are never redelivered).
  **Upgrading:** a `queue.json` left by a prior version is no longer read — a turn that was queued
  (not yet started) at the upgrade moment is dropped rather than replayed (re-ask); the now-inert
  file lives under the gitignored `.fastagent/channels/telegram/` and can be deleted.

### Removed

- **The pre-0.x global-credential migration hint** in the startup auth report. It probed
  `GLOBAL_AUTH_PATH` when the project auth file was empty and pointed a pre-0.x upgrader at it — a
  backward-compat aid with no place in a pre-release. The report now falls back to the generic
  `fastagent login` hint, consistent with the no-implicit-fallback design.

## [0.8.2] - 2026-07-04

### Changed

- **The folder is live: AGENTS.md and `skills/` are re-read on every invoke** (folder-rung agents:
  `createPiAgentFromDefinition`, `dev`, `start`). Edits — the author's or the agent's own — take
  effect on the next turn with no process restart; a broken edit fails that turn visibly instead of
  the process. `createPiAgent` (typed parts) is unchanged, and `fastagent chat` keeps its startup
  snapshot — restart it to pick up edits.
- **`dev` watch scope narrowed to code inputs** (`tools/`, `channels/`, `fastagent.config.*`,
  `package.json`, `.env`) — the only changes that require a new process (ESM module cache). Files
  the agent writes into its own workspace no longer kill its in-flight turn with a restart;
  definition edits no longer restart at all (they are live, above). Helper code imported from
  outside `tools/`/`channels/` is out of watch scope — keep it under `tools/`, or restart manually.

## [0.8.1] - 2026-07-04

### Fixed

- **`--tunnel` no longer mistakes cloudflared's API endpoint for the assigned tunnel URL.** Under a
  flaky network, a cloudflared ERROR line mentioning `https://api.trycloudflare.com/tunnel` parsed
  as the tunnel URL and the Telegram webhook got registered against Cloudflare's API host — the bot
  silently received nothing while every log line said success.
- **Transient provider request failures no longer kill the turn** for providers whose pi-ai
  adapters implement client-side retries (OpenAI-family / Anthropic / Azure / Codex — request-phase
  network errors / 429 / 5xx with backoff; all previously defaulted to 0 retries). The google /
  vertex / bedrock / mistral adapters ignore `maxRetries`, so transients there still fail the
  turn. Mid-stream drops also still fail the turn — partial output was already streamed and
  cannot be retracted.

## [0.8.0] - 2026-07-03

### Breaking

- **Auth is project-level by default.** The credentials file defaults to
  `<dir>/.fastagent/auth.json` (was the global `~/.fastagent/auth.json`); `fastagent login`,
  `dev`, `start`, `invoke`, and `info` all resolve it as `--auth-path` > `FASTAGENT_AUTH_PATH` >
  project default, with no implicit project↔global fallback (isolation + fail-visibly). (`fastagent
  chat` is exempt — it authenticates through pi's own TUI / `~/.pi`, not fastagent's credential file.)
  **Migration:** existing global logins are not used automatically — `dev`/`start`/`invoke` print a
  hint when the global file has the credential; set `FASTAGENT_AUTH_PATH=~/.fastagent/auth.json` to
  keep using it (sharing one file is safe), or `fastagent login` in the project for a project-level
  credential.
- The exported `FASTAGENT_AUTH_PATH` constant is renamed `GLOBAL_AUTH_PATH` (it is the global
  location, no longer the default). No deprecation alias — the constant's meaning changed from *the
  default path* to *the global location* (the value you point the `FASTAGENT_AUTH_PATH` env var at),
  so reusing that name would mislead. `createPiAgent`, `createPiAgentFromDefinition`, and
  `createPiModels` gain an `authPath` option; the dir-aware `createPiAgentFromDefinition` defaults it
  to the project-level `<dir>/.fastagent/auth.json` (the dir-less `createPiAgent`/`createPiModels`
  still default to the global file).

### Added

- **Telegram channel** (`@kid7st/fastagent/telegram` + `fastagent add telegram`): serve an agent as
  a Telegram bot — webhook ingress (secret-token verified, fail-closed), photos as vision inputs,
  documents/voice/video downloaded for the agent's tools, replies/threads/topics auto-adapted, and a
  customizable `onError`/`route` policy surface. Highlights:
  - **Live streaming preview:** one real message ("💭 Thinking…") edited in place with reasoning
    tail + tool calls + partial answer, morphing into the final HTML answer — works in groups and
    private chats alike; a single-writer pump keeps frames monotonic (no flicker).
  - **Group-native behavior:** a shared per-chat session with sender attribution; concurrent
    summons run serially (FIFO) with an immediate "⏳ Queued" notice reply-quoted to the asker;
    un-summoned discussion is buffered (bounded) and folded into the next answered turn — including
    attachments, so "summarize the file from earlier" actually opens it, attributed to its sender.
  - **Precise summoning:** group summon only on a `mention` entity naming the bot (never a text
    scan — code blocks/URLs can't false-summon) or a reply to THIS bot (matched by the bot id
    parsed from the token; a multi-bot group never mis-triggers); edited messages and slash
    commands do not summon.
  - **Durable across restarts** (single-process): the context buffer persists before each webhook
    ACK, and accepted turns live in a WAL — never-started turns replay in arrival order, a
    mid-flight one is dropped loudly and its redelivery suppressed (a duplicate reply is worse than
    a visible loss). State lives under `.fastagent/channels/telegram/` (self-git-ignored; the
    `stateDir` option moves everything as one unit).
  - **Hardened transport:** one Bot API pipeline — per-attempt timeouts (30s API / 120s
    downloads), bounded 429/flood-wait retry, success gated on the body's own `ok:true`,
    self-describing failures; long replies (>4096 chars) split as valid HTML via a tag balancer
    (a `<pre>` code block spanning the boundary stays formatted).
- `--tunnel` for `dev`/`start`: expose the local server on a public HTTPS URL via a Cloudflare
  quick tunnel and auto-register webhook channels (telegram setWebhook; github prints the URL),
  with `HTTPS_PROXY` support end to end.
- Engine auto-compaction: after a completed turn crosses the context-window threshold, the session
  is compacted before the next turn — long-running chats no longer hit the window.
- Leveled logging (`FASTAGENT_LOG_LEVEL`, or posture defaults: `dev`=debug, `start`=info); turn
  traces log at debug in both postures, keeping end-user content out of production logs.
- Channel-authoring kit exports: `readBodyCapped`, `text`, `textHeaders`; new public types
  (`AgentTool`, `Skill`, `SkillDiagnostic`, `Session`, `Model`, `Provider`/`createProvider`).
- `SECURITY.md`, `CHANGELOG.md`, and `llms.txt` for open-source readiness.
- README status badges (CI, npm version, license, Node version).
- `ai-start.md`: an AI-guided setup prompt for coding agents.
- Restructured public docs: `docs/README.md` index, `overview`, `cli`, `configuration`,
  `api-reference`, `troubleshooting`, `principles`, dedicated channel guides
  (`github`, `telegram`, `channel-development`), and maintainer notes under `docs/design/`
  (`core.md` §9.2 documents the telegram channel architecture).

### Changed

- Narrative reframed to "Vibe first. Then FastAgent." — take a local agent folder out of
  the terminal and serve it in an app, on GitHub, in Telegram, or behind a custom channel.
- Scaffold templates are real files (copied to dist), channel bundles live beside their channel,
  and `fastagent add <channel>` drops files by convention without touching your `AGENTS.md`.

### Fixed

- `fastagent login <provider>` now loads `.env` from the current directory. It previously
  resolved `.env` against `./<provider>` (the positional is the provider, not a dir), so a proxy
  (e.g. `HTTPS_PROXY`) set in the workspace `.env` was ignored during the OAuth token exchange.
- A leading `~` in path overrides is now expanded to the home dir. Both `--auth-path` /
  `FASTAGENT_AUTH_PATH` and `--sessions-dir` / `FASTAGENT_SESSIONS_DIR` previously took `~/x` from a
  non-shell source (e.g. `.env`) literally, creating a `<cwd>/~` directory instead of resolving to
  home.

### Removed

- `core/examples/` (better examples will be added later).

## [0.7.1]

Last release before the open-source documentation pass. Earlier history is in the
[commit log](https://github.com/kid7st/fastagent/commits/main).

[Unreleased]: https://github.com/kid7st/fastagent/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/kid7st/fastagent/compare/v0.8.3...v0.9.0
[0.8.3]: https://github.com/kid7st/fastagent/compare/v0.8.2...v0.8.3
[0.8.2]: https://github.com/kid7st/fastagent/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/kid7st/fastagent/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/kid7st/fastagent/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/kid7st/fastagent/releases/tag/v0.7.1
