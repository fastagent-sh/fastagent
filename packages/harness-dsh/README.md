# @fastagent-sh/harness-dsh (Experimental)

Run any [FastAgent](https://github.com/fastagent-sh/fastagent) with kernel-enforced OS sandboxing (`sandbox-exec` on macOS, `bwrap` / `Landlock` on Linux, restricted tokens on Windows) powered by [DeepSeek Harness (`@deepseek-ai/dsh`)](https://github.com/deepseek-ai/deepseek-harness)—with zero changes to your prompt, skills, portable tools, or callers.

## Install

```bash
npm install @fastagent-sh/harness-dsh
```

## Use with FastAgent

Enable in `fastagent.config.ts`:

```ts
import { defineAgent } from "@fastagent-sh/fastagent";

export default defineAgent({
  model: "anthropic/claude-sonnet-4-6",
  harness: "dsh",
  sandbox: "workspace", // "workspace" (default) | "read-only" | "off"
  codingTools: true,
});
```

Or override per CLI command:

```bash
fastagent dev --harness dsh
fastagent dev --harness dsh --sandbox read-only
fastagent invoke "summarize this repo" --harness dsh
fastagent start --harness dsh
```

Or programmatically via `openAgent()`:

```ts
import { baseEnv, openAgent } from "@fastagent-sh/fastagent";
import myAgent from "./dist/index.js";

const agent = await openAgent(myAgent, {
  root: "/var/lib/myapp/agent",
  secrets: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
  env: baseEnv(process.env),
  harness: "dsh",
  sandbox: "workspace",
});
```

## What stays the same (and what differs)

- **Same Agent API:** Streaming, `steer` / `queue` / `reject`, idempotency, cancellation, forking, compaction, attachments, usage, OTLP traces, and crash recovery work identically.
- **Same storage:** Shares your SQLite file or PostgreSQL database in its own table namespace (`dsh_*`) without touching `pi-durable` sessions, while sharing durable credentials and conversation mappings.
- **Same portable assets:** `SYSTEM.md`, `AGENTS.md`, `skills/`, `prompts/`, `src/tools/` (`defineTool` from `@fastagent-sh/fastagent`), and `mcpServers` run identically.
- **`src/extensions/`:** `pi-durable`-specific extensions are skipped with a startup warning on `dsh`.

## Experimental status

Pins `@deepseek-ai/dsh@0.2.2-rc.5` while upstream matures toward a stable release.

See [Configuration](https://github.com/fastagent-sh/fastagent/blob/main/docs/configuration.md#harness-and-sandbox-selection) and [Technical architecture](https://github.com/fastagent-sh/fastagent/blob/main/docs/architecture.md).
