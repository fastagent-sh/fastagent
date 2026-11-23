---
title: Packaging, Distribution & CI/CD
description: "Compile a FastAgent project into a versioned npm package with fastagent build, gate releases in CI with deterministic exit codes, and roll forward or back like normal TypeScript code."
status: current
---

# Packaging, Distribution & CI/CD

A FastAgent project is standard Markdown and TypeScript — no proprietary graph DSL and no hidden cloud state. `fastagent build` compiles that project into a self-contained, immutable npm package under `dist/` so you can version, test, publish, embed, and roll back agents through the same engineering workflow as any other TypeScript library.

## 1. What `fastagent build` produces

Run `fastagent build` inside an agent directory:

```bash
fastagent build           # type-checks with tsc and emits dist/
fastagent build --json    # machine-readable output for CI and coding agents
```

`fastagent build` stages output into `.fastagent/build` and swaps `dist/` atomically only after every check succeeds — a failed build never corrupts the last working `dist/`.

```text
dist/
├── index.js              # generated ESM entry exporting default AgentDefinition
├── index.d.ts            # TypeScript declarations (export default definition: AgentDefinition)
├── package.json          # standalone ESM manifest with runtime packages in peerDependencies
├── build.json            # SHA-256 source fingerprint so `fastagent start` rejects stale builds
├── SYSTEM.md             # copied prompts, rules, README, and license files
├── AGENTS.md
├── skills/               # copied Agent Skills
├── prompts/              # copied prompt templates
├── assets/               # copied static assets
├── fastagent.config.js   # compiled configuration
└── src/                  # compiled tools and extensions (tests excluded)
```

### Built-in safety & hygiene checks

Every build enforces strict artifact boundaries before anything is written to `dist/`:

- **Full TypeScript verification:** Compiles `fastagent.config.ts` and every module in `src/tools/` and `src/extensions/` with the project's `tsc` (pass `--no-check` only when you already ran `tsc --noEmit`).
- **No out-of-tree imports:** Refuses source imports from outside the agent directory that `dist/` cannot carry.
- **No machine state or secrets:** Never copies `.secrets/`, `.env*`, `.state/`, `node_modules/`, `.git/`, or anything from `~/.pi/agent`.
- **MCP command & credential checks:** Verifies relative stdio MCP commands exist inside `dist/` and emits warnings if `mcpServers` contains literal credentials instead of `${VAR}` references.
- **Shared runtime via `peerDependencies`:** `dist/package.json` moves `@fastagent-sh/fastagent` and installed harness packages into `peerDependencies`. When a host application embeds several agents at once, Node installs one shared runtime instead of duplicating it per agent.

## 2. Distribute & version as an npm package

Because `dist/` is a complete ESM package (`"type": "module"` with `exports["."]` pointing to `./index.js` and `./index.d.ts`), you can distribute an agent through any standard JavaScript package workflow:

### Option A: Publish to a private (or public) npm registry

```bash
# Inside your agent repository (or CI release job)
fastagent build
npm publish ./dist --access restricted
```

Then install and pin it in your host backend like any other library:

```bash
npm install @acme/saas-copilot@1.4.2
```

```ts
import { baseEnv, openAgent } from "@fastagent-sh/fastagent";
import copilot from "@acme/saas-copilot";

const agent = await openAgent(copilot, {
  root: "/var/lib/myapp/copilot",
  secrets: { OPENAI_API_KEY: process.env.OPENAI_API_KEY },
  env: baseEnv(process.env),
});
```

Upgrading an agent — or rolling back a prompt or tool regression — is a single SemVer version change in `package.json`. In long-lived hosts or desktop apps, call `await agent.close()` and reopen the new build.

### Option B: Consume directly in a monorepo workspace

Keep the agent in `packages/saas-copilot/`, build it in your workspace pipeline (`fastagent build`), and import its compiled package from your Next.js, Hono, Express, or Fastify app without publishing externally.

## 3. Gate releases in CI/CD

Every FastAgent CLI command is designed for both coding agents and unattended CI pipelines:

- Never blocks waiting for interactive terminal input (pass `--no-input` or rely on non-TTY detection; missing arguments exit `2` with an actionable message).
- Data commands emit structured JSON with `--json` and return deterministic exit codes (`0` pass, `1` fatal error or leak detected, `2` invalid usage or missing input).

Example GitHub Actions workflow gating build, tests, and container secret checks:

```yaml
name: Verify & Ship Agent
on: [push, pull_request]

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "24"
      - run: npm ci
      - run: fastagent info --json
      - run: fastagent build --json
      - run: fastagent deploy check --json
```

- `fastagent info --json` validates the agent definition and reports models, tools, MCP servers, and declared `needs()` secrets read-only.
- `fastagent build --json` runs TypeScript checks and emits the immutable `dist/` artifact, printing `{ dist, name, version, warnings }`.
- `fastagent deploy check --json` inspects the Docker build context and exits `1` if `.secrets/`, `.env*`, or `.state/` would leak into the container image.

## 4. Built for human + coding agent maintenance

Because an agent contains only Markdown prompts/skills and typed TypeScript modules — with zero visual canvas exports or proprietary graph DSLs — coding agents (Claude Code, Codex, Cursor, Pi) can read, edit, refactor, and verify the entire project using the exact same loop as your engineers:

1. Edit `SYSTEM.md`, `skills/<name>/SKILL.md`, or `src/tools/*.ts`.
2. Run `fastagent info --json` and `fastagent build --json` to verify types and config.
3. Smoke-test deterministically with `fastagent invoke --json "..."`.
4. Run `fastagent deploy check --json` before opening a PR or cutting a release.

## Next steps

- Embed a built agent package in your backend: [Embedding](embedding.md)
- Ship containers or sleep-when-idle cloud services: [Deploy](deploy.md)
- Run isolated per-user microVMs on AWS: [Amazon Bedrock AgentCore](agentcore.md)
- Full CLI flags and exit codes: [CLI reference](cli.md)
