---
title: MCP Servers
description: "Connect external tools from local stdio or remote Streamable HTTP MCP servers with safe secret interpolation, timeouts, and environment isolation."
status: current
---

# MCP Servers

Connect external tools from any local **stdio** or remote **Streamable HTTP** Model Context Protocol (MCP) server by declaring it under `mcpServers` in `fastagent.config.ts`. Each discovered tool is exposed to the model as `mcp__<server>__<tool>` on both `pi-durable` and `dsh`.

FastAgent ignores `.mcp.json`, editor settings, and home-directory configs so your agent's tool set is always explicit, portable, and reproducible across machines and containers.

**Supported:** MCP protocol `2026-07-28`, tools returning text or JSON results, over **stdio** or **Streamable HTTP** with custom headers.
**Not supported:** MCP OAuth flows, resources, prompts, sampling, elicitation, legacy HTTP+SSE, older protocol versions, or live tool-list hot reload (reopen the agent to pick up newly added tools).

## Local servers (stdio)

```ts
import { defineAgent } from "@fastagent-sh/fastagent";

export default defineAgent({
  model: "openai/gpt-5.5",
  mcpServers: {
    project: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/srv/project"],
      env: { LOG_LEVEL: "info" },
    },
  },
});
```

- Starts in the instance's working directory without invoking a shell. FastAgent does not auto-install binaries: use `npx -y`, add the package to `package.json`, or install it in your container's `Dockerfile`.
- Receives only a minimal base environment (`PATH`, `HOME`, temp, locale) plus its declared `env`—never ambient host secrets.
- A relative or local executable path must live under `assets/` so `fastagent build` bundles it into `dist/`.

## Remote servers (Streamable HTTP)

```ts
import { defineAgent } from "@fastagent-sh/fastagent";

export default defineAgent({
  model: "openai/gpt-5.5",
  mcpServers: {
    internal: {
      type: "http",
      url: "https://mcp.example.com/mcp",
      headers: {
        Authorization: "Bearer ${SERVICE_TOKEN}",
      },
    },
  },
});
```

- **HTTPS required** for non-loopback URLs. Redirects are refused so your declared headers can never leak to another host.
- **Secret interpolation:** `${NAME}` placeholders in `command`, `args`, `env`, and `headers` resolve from instance secrets (`.secrets/.env`, container env, or `openAgent({ secrets })`). Missing variables fail startup immediately; never hardcode tokens in `fastagent.config.ts`.
- **Auth errors:** HTTP `401` or `403` fails startup with `McpError("authorization_required")`.
- **Proxies:** Standard `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` apply automatically.

Run `fastagent info` to inspect declared MCP servers and any secrets they require.

## Timeouts & failure handling

- **Timeouts:** Protocol probe times out at 15 s, initial connection at 30 s, and each request or tool call at 60 s.
- **Cancellation:** Canceling a session forwards cancellation to the MCP server (whether it stops immediately depends on the server).
- **Crash recovery:** An MCP tool call interrupted by a restart is reported as interrupted rather than automatically re-executed.
- **Unsupported payloads:** Non-text/non-JSON tool outputs surface as visible tool errors.
- **Idempotent startup:** The client may probe a server during negotiation before full connection; avoid irreversible side effects during server initialization.
