---
title: MCP servers
description: "Use local stdio and remote Streamable HTTP MCP tools, declared in fastagent.config.ts with their credentials from the environment."
status: current
---

# MCP servers

Give the agent tools from MCP servers by declaring them under `mcpServers` in `fastagent.config.ts`.

`.mcp.json`, editor settings and your home directory are not read. Paste a server's documented entry there. Tools are
named `mcp__<server>__<tool>`.

**Supported:** MCP 2026-07-28, tools with text or JSON results, over stdio or Streamable HTTP with the headers the
declaration names. **Not supported:** OAuth sign-in, resources, prompts, sampling, elicitation, older protocol
versions, legacy HTTP+SSE, live tool-list updates. Reopen the agent to pick up new tools.

## Local servers (stdio)

```json
{
  "mcpServers": {
    "project": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/srv/project"],
      "env": { "LOG_LEVEL": "info" }
    }
  }
}
```

- The server runs in the instance's working directory, without a shell. FastAgent does not install it: `npx -y`
  fetches it, or install the CLI in your image `Dockerfile`.
- It gets only a minimal environment (`PATH`, `HOME`, temp and locale) and its own `env`.
- A program's command that is a path must be under `assets/`, which `build` ships.

## Remote servers (HTTP)

```json
{
  "mcpServers": {
    "internal": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${SERVICE_TOKEN}" }
    }
  }
}
```

- HTTPS is required, except for loopback during development. Redirects are not followed.
- `${NAME}` in `command`, `args`, `env` and `headers` is filled from the instance's secrets; a missing one fails the
  open. Never write a credential into the file.
- A server that refuses its credentials (HTTP 401 or 403) fails the open with `authorization_required`.
- `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` apply.

`fastagent info` lists the servers the agent declares.

## Failures

- Cancelling a tool forwards the cancel; the server may ignore it.
- An interrupted MCP call is reported, not run again after a restart.
- Connecting times out after 30 s, and each request and tool call after 60 s. Unsupported content is a visible tool error.
- A server's startup may run twice (the SDK probes it first): keep irreversible work out of it.
