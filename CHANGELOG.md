# Changelog

All notable changes to `@kid7st/fastagent` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the project is pre-1.0, minor versions may include breaking changes.

## [Unreleased]

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
- `start.md`: an AI-guided setup prompt for coding agents.
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

[Unreleased]: https://github.com/kid7st/fastagent/compare/v0.8.1...HEAD
[0.8.1]: https://github.com/kid7st/fastagent/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/kid7st/fastagent/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/kid7st/fastagent/releases/tag/v0.7.1
