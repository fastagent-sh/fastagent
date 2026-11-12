---
title: MCP servers
description: "Use local stdio and remote Streamable HTTP MCP tools, with browser OAuth and instance-owned clients."
status: current
---

# MCP servers

Give the agent tools from MCP servers by declaring them under `mcpServers`:

- in `context.json`: the agent's own, shipped to every instance;
- in an instance's `fastagent.json`: that instance's extra ones (a name in both refuses the open).

`.mcp.json`, editor settings and your home directory are not read. Paste a server's documented entry into one of the
two files. Tools are named `mcp__<server>__<tool>`.

**Supported:** MCP 2026-07-28, tools with text or JSON results, over stdio or Streamable HTTP, with OAuth
(authorization code + PKCE). **Not supported:** resources, prompts, sampling, elicitation, older protocol versions,
legacy HTTP+SSE, live tool-list updates. Reopen the agent to pick up new tools.

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
  fetches it, or declare it in the agent's [environment](configuration.md#environment).
- It gets only a minimal environment (`PATH`, `HOME`, temp and locale) and its own `env`.
- A program's command that is a path must be under `assets/`, which `build` ships.

## Remote servers (HTTP)

```json
{
  "mcpServers": {
    "linear": {
      "type": "http",
      "url": "https://mcp.linear.app/mcp/readonly"
    },
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
- Addresses are checked: a hostname that resolves to a private or reserved address is refused. A declared local
  address allows only that exact origin.
- `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` apply.

## Signing in (OAuth)

```bash
fastagent mcp list --json                          # servers and whether they are signed in
fastagent mcp login linear --scopes read --json    # returns a ticket and the URL for the person
fastagent mcp login --check <ticket> --json
fastagent mcp disconnect linear --json             # this instance's binding only; the grant is not revoked
```

- The person opens the URL; the browser returns to `127.0.0.1` on this machine. Never paste a token or the callback
  address into a coding agent's conversation.
- Without a terminal, `--scopes` is required. `--client-id` uses a pre-registered client; then register
  `http://127.0.0.1:<port>/mcp/oauth/callback` and pass `--callback-port <port>`.
- For a remote CLI, forward the callback port. A deployment signs in on its own: local grants are never copied there.
- Grants are kept in `.secrets/mcp-auth.json` (an app's: `<state>/mcp-auth.json`). Revoking access is done in the
  provider's account settings.

## In an app

```ts
import { inspectMcp, mcpGrantFile, openAgent, signInMcp } from "@fastagent-sh/fastagent";

const store = mcpGrantFile("/private/app-data/mcp-grants.json");
const grant = await signInMcp({
  agentDir,
  server: "linear",
  store,
  scopes: ["read"],
  interaction: {
    signal: cancelSignal,
    confirmAuthorization: showAuthorizationConsent,
    notify: showSignInProgressOrOpenBrowser,
  },
});

// Persist this choice in the host's instance record, not in the server's declaration.
const mcp = { store, bindings: { linear: grant.id } };
const state = await inspectMcp(agentDir, mcp);
const agent = await openAgent(definition, { workdir, stateDir: instanceStateDir, mcp });
```

`confirmAuthorization` shows the server, issuer and scopes and returns whether the person agreed; `notify` opens the
browser and shows progress. Nothing opens a browser on its own. A custom `McpGrantStore` (encrypted app storage, say)
must serialize everyone sharing a grant and write durably. Pass `store` and `bindings` together. Two agents may share
a grant; closing one does not sign the other out.

## Failures

- Cancelling a tool forwards the cancel; the server may ignore it.
- A refresh whose outcome is unknown is not retried with the old token: sign in again.
- An interrupted MCP call is reported, not run again after a restart.
- Requests time out after 30 s (discovery, auth) and 60 s (tool calls). Unsupported content is a visible tool error.
- A server's startup may run twice (the SDK probes it first): keep irreversible work out of it.
