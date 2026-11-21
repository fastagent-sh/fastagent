# @fastagent-sh/harness-dsh (Experimental)

Optional second runtime harness for [FastAgent](https://fastagent.sh) backed by [DeepSeek Harness (`@deepseek-ai/dsh`)](https://github.com/deepseek-ai/deepseek-harness), adding kernel-enforced OS sandboxing (`sandbox-exec` on macOS, `bwrap` / `Landlock` on Linux, restricted-token ACL on Windows) while implementing the full FastAgent Agent API.

## Install

```bash
npm install @fastagent-sh/harness-dsh
```

## Use with FastAgent

Switch in `fastagent.config.ts`:

```ts
import { defineAgent } from "@fastagent-sh/fastagent";

export default defineAgent({
  model: "anthropic/claude-sonnet-4-6",
  harness: "dsh",
  sandbox: "workspace", // "workspace" (default) | "read-only" | "off"
  codingTools: true,
});
```

Or override per command without editing config:

```bash
fastagent dev --harness dsh
fastagent dev --harness dsh --sandbox read-only
fastagent invoke "summarize this repo" --harness dsh
fastagent start --harness dsh
```

Or programmatically with `openAgent()`:

```ts
import { baseEnv, openAgent } from "@fastagent-sh/fastagent";
import myAgent from "./dist/index.js";

const agent = await openAgent(myAgent, {
  root: "/var/lib/myapp/agent",
  env: baseEnv(process.env),
  harness: "dsh",
  sandbox: "workspace",
});
```

## Compatibility

- **Full Agent API**: passes the full `test/harnesses/agent-api-conformance.ts` suite (streaming, `steer` / `queue` / `reject`, idempotency, cancellation, forking, compaction, attachments, usage, context usage, crash recovery).
- **Shared storage**: shares the instance's `agent.sqlite` (with kernel-enforced `EXCLUSIVE` locking) or PostgreSQL database (`dsh_*` tables + `dsh_leases` fencing) without colliding with `pi-durable`.
- **Portable assets**: `SYSTEM.md`, `AGENTS.md`, `skills/`, `prompts/`, `src/tools/` (`defineTool`), `mcpServers`, and `src/schedules/` work identically on both harnesses.
- **`src/extensions/`**: `pi-durable`-specific extensions are skipped with a startup warning on `dsh`.

## Experimental status

This package pins `@deepseek-ai/dsh@0.2.2-rc.5` while upstream matures toward a stable release.
