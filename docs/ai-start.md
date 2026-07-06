# FastAgent AI-guided start

Use this prompt with Claude Code, Codex, pi, or another coding agent when you want help creating or wiring a FastAgent workspace.

```txt
You are helping me use FastAgent.

Goal: turn an existing agent directory into a deployable agent without rewriting it.

FastAgent mental model:
- The directory is the agent: AGENTS.md + skills/ + optional tools/ + optional channels/.
- FastAgent can run it locally, embed it in my app, or connect it to channels like GitHub and Telegram.
- Do not invent a new framework layout unless I ask. Prefer the existing directory.

First inspect my project:
1. Check whether AGENTS.md exists.
2. Check whether skills/, tools/, channels/, fastagent.config.* exist.
3. Check package.json for "type": "module" if code tools are present.
4. Ask before choosing a model provider or adding secrets.

If I do not have a workspace yet:
- Run: fastagent init <dir>
- Then explain the generated files.

If I already have a workspace:
- Run: fastagent info
- Fix only the issues it reports.

For local testing:
- Run: fastagent dev
- Send a test turn to POST /invoke, or run: fastagent invoke "hello"

For tools:
- Put tools in tools/<name>.ts.
- Use defineTool and z from @kid7st/fastagent.
- Test with: fastagent tool <name> '<json>'

For GitHub:
- Run: fastagent add github
- Edit channels/github.ts so on(event) maps real GitHub events to { session, text } intents.
- Use fastagent dev --tunnel for local webhook testing.

For Telegram:
- Run: fastagent add telegram
- Set TELEGRAM_BOT_TOKEN and TELEGRAM_SECRET_TOKEN.
- Use fastagent dev --tunnel for local webhook testing.

For embedding:
- Use createPiAgentFromDefinition or createPiAgentFromWorkspace.
- Mount createInvokeHandler(agent) in my app route.
- Keep my app's auth/database/session ownership in my app.

Before finishing:
- Run fastagent info.
- Run the smallest useful smoke test: fastagent invoke "hello" or a channel-specific local test.
- Do not commit .env, credentials, sessions, or .fastagent machine state.
```

References:

- [Quickstart](quickstart.md)
- [Configuration](configuration.md)
- [Embedding](embedding.md)
- [Channels](channels.md)
- [Troubleshooting](troubleshooting.md)
