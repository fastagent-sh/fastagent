# Changelog

All notable changes to `@kid7st/fastagent` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the project is pre-1.0, minor versions may include breaking changes.

## [Unreleased]

### Added
- `SECURITY.md`, `CHANGELOG.md`, and `llms.txt` for open-source readiness.
- README status badges (CI, npm version, license, Node version).
- `start.md`: an AI-guided setup prompt for coding agents.
- Restructured public docs: `docs/README.md` index, `overview`, `cli`, `configuration`,
  `api-reference`, `troubleshooting`, `principles`, dedicated channel guides
  (`github`, `telegram`, `channel-development`), and maintainer notes under `docs/design/`.

### Changed
- Telegram channel state is now durable across restarts (single-process deployments): the group-context buffer persists before each webhook ACK, and accepted turns live in a pending-turn WAL — on restart, never-started turns replay in arrival order while a mid-flight one is dropped with an error log (a duplicate reply is worse than a visible loss). State lives under `.fastagent/channels/telegram/` (the new channel-state convention; inbound files moved there too, from `.fastagent/telegram-files/` — old dirs are orphaned, delete freely), written atomically, with corrupt files degrading visibly to empty. New `stateDir` option overrides the location.
- Telegram group summon precision: a reply summons only when it replies to THIS bot — matched by the bot's numeric id, parsed synchronously from the token (`<bot_id>:<secret>`), so a reply to another bot in a multi-bot group never triggers ours and there is no getMe race window; with no identity at all the check fails closed (a bare `defaultTelegramRoute` call needs `botId`/`botUsername` for reply summon). Edited messages no longer summon at all (each typo fix used to produce a duplicate answer); `TelegramUpdate` drops `edited_message`/`edited_channel_post` accordingly (they are ACKed before `route` sees them).
- Telegram: `TelegramUpdate` no longer declares `callback_query` — the channel ACKs and drops non-message updates before `route` sees them, so the field advertised an interaction that could never be delivered (the raw payload stays reachable via the index signature). Re-add it together with real button support, not before.
- Telegram: group @mention summon now reads Telegram's own `mention` entities instead of scanning the text with a regex — an `@botname` pasted inside a code block or a URL no longer summons (not a mention entity), a mention of a different user whose name starts with the bot's cannot match (exact entity range), and `/cmd@bot` stays a command. No text fallback: mention entities are produced server-side.
- Telegram transport rewritten around a single pipeline (`callApi`): per-method wire code no longer exists, so the transport invariants — a per-attempt timeout on every call (30s API / 120s file bytes), bounded 429 retry honouring `retry_after` up to a 30s flood-wait cap, success gated on the body's own `ok:true` (a proxy's 200 + error page is a named failure, not a sent message), and self-describing `TelegramApiError`s — hold for every call by construction, including `--tunnel` webhook registration. The scaffold send-tool carries a documented standalone copy (fail-fast, no 429 retry: the agent sees the error and decides).
- Telegram: a long reply (>4096 chars) is split as valid HTML — a tag that spans a boundary is closed at the chunk's end and reopened (attributes and all) at the next chunk's start, so a long `<pre>` code block stays formatted instead of degrading to plain text. The split also never cuts through a tag token.
- Narrative reframed to "Vibe first. Then FastAgent." — take a local agent folder out of
  the terminal and serve it in an app, on GitHub, in Telegram, or behind a custom channel.
- **Auth is now project-level by default.** The credentials file defaults to
  `<dir>/.fastagent/auth.json` (was the global `~/.fastagent/auth.json`); `fastagent login`,
  `dev`, `start`, `invoke`, and `info` all resolve it as `--auth-path` > `FASTAGENT_AUTH_PATH` >
  project default, with no implicit project↔global fallback (isolation + fail-visibly). (`fastagent
  chat` is exempt — it authenticates through pi's own TUI / `~/.pi`, not fastagent's credential file.)
  **Migration:**
  existing global logins are not used automatically — `dev`/`start`/`invoke` now print a hint when the
  global file has the credential; set `FASTAGENT_AUTH_PATH=~/.fastagent/auth.json` to keep using it
  (sharing one file is safe), or `fastagent login` in the project for a project-level credential.
- **Breaking (API):** the exported `FASTAGENT_AUTH_PATH` constant is renamed `GLOBAL_AUTH_PATH`
  (it is the global location, no longer the default). No deprecation alias — the constant's meaning
  changed from *the default path* to *the global location* (the value you point the
  `FASTAGENT_AUTH_PATH` env var at), so reusing that name for it would mislead. `createPiAgent`,
  `createPiAgentFromDefinition`, and `createPiModels` gain an `authPath` option; the dir-aware
  `createPiAgentFromDefinition` defaults it to the project-level `<dir>/.fastagent/auth.json` (the
  dir-less `createPiAgent`/`createPiModels` still default to the global file).

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

[Unreleased]: https://github.com/kid7st/fastagent/compare/v0.7.1...HEAD
[0.7.1]: https://github.com/kid7st/fastagent/releases/tag/v0.7.1
