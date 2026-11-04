---
title: MCP servers
description: "Use local stdio and remote Streamable HTTP MCP tools, with browser OAuth and instance-owned clients."
status: current
---

# MCP servers

Declare servers in **`.mcp.json` at the agent directory's root**. Each opened agent owns its clients. Servers are not read
from `context.json`, editor settings, parent folders or your home directory.

FastAgent uses MCP **2026-07-28**. An older-only server is refused, not silently downgraded. The first implementation
supports tools with text/JSON results over stdio and Streamable HTTP. It does not provide resources/prompts, sampling,
elicitation, tasks, legacy HTTP+SSE or live tool-list updates. OAuth uses authorization code + PKCE with bearer tokens;
DPoP and machine-to-machine grant flows are not supported. Reopen the agent to refresh its tools.

## Local tools: stdio

Install the server and its runtime in the agent's environment, then declare its command:

```json
{
  "mcpServers": {
    "project": {
      "command": "node",
      "args": ["./node_modules/@modelcontextprotocol/server-filesystem/dist/index.js", "./content/project"],
      "env": { "LOG_LEVEL": "info" }
    }
  }
}
```

This example requires the server package and an existing `content/project` directory. FastAgent does not install MCP
packages automatically. Commands containing a path resolve relative to the agent directory; bare names use the instance's
PATH. The server runs with the agent directory as cwd, with arguments passed verbatim, without a shell.

Only execution necessities (`PATH`, `HOME`, `USERPROFILE`, `SystemRoot`, `SYSTEMROOT`, `TEMP`, `TMP`, `TMPDIR`, `LANG`,
`LC_ALL`) and the server's declared `env` are forwarded. The SDK may also inherit its small platform-default environment;
it does not receive other model/server credentials from the agent's environment automatically. Declare any additional
variable the server needs explicitly.

## Remote tools: Streamable HTTP

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

`http` means Streamable HTTP. HTTPS is required except for loopback development endpoints. URL userinfo and fragments
are refused. A static `Authorization` header and an OAuth binding cannot be combined for the same server.

`${NAME}` substitutions are supported in `command`, `args`, `env` and `headers`, from the selected instance environment.
Missing or empty referenced values fail before connection. Other interpolation syntax, unknown fields, unsupported
transports and malformed JSON are errors; no secondary configuration file is tried. The supported entry fields are
`type`, `command`, `args`, `env` for stdio and `type`, `url`, `headers` for HTTP. Omitted `type` means stdio.

Server names contain 1–40 letters, digits, hyphens or underscores, without `__`. Tools are named
`mcp__<server>__<tool>`; the resulting name must fit 64 characters using letters, digits, underscores and hyphens.
Conflicting or invalid names fail open, including collisions with authored tools.

Do not commit credentials in this file. Use environment references or OAuth. The built-in, instance-owned HTTP transport
honors `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` from the process environment, without replacing global fetch or changing
process variables. It validates every DNS answer and pins connections (including proxy CONNECT) to the selected IP,
preserving the original Host and TLS certificate name. It never follows HTTP redirects.

Metadata-derived URLs cannot reach loopback, private, link-local or reserved addresses. A declared literal local/private
endpoint, or localhost, permits only that exact origin; it does not authorize another local port or issuer. Hostnames
resolving to non-public addresses are refused, including proxy fake-IP ranges such as `198.18.0.0/15`. Use a resolver that
returns routable addresses rather than bypassing this check. Pins last for the opened instance; reopen to resolve again.

An explicit `mcp.fetch` is a **trusted host transport override**, also used for discovery and refresh. URL/protocol checks
still apply, but FastAgent cannot control that function's sockets: the host must enforce equivalent DNS pinning, private
address and redirect protections. Existing global fetch replacements are not implicitly adopted.

## Browser OAuth from the CLI

```bash
fastagent mcp list --json
fastagent mcp login linear --scopes read --json
fastagent mcp login --check <ticket> --json
```

The first command reports declarations and **local authorization state**, not remote health. Login returns a ticket and
the authorization URL for the person to open. The callback receives the code directly; never paste a token or callback
address into a coding-agent conversation. Without a terminal, `--scopes` must explicitly name the comma-separated scopes.
At a terminal the command asks for scope consent before opening the browser.

`--env production` selects independent production credentials and bindings. `--client-id` supplies a pre-registered
public client ID or a client metadata URL. Otherwise FastAgent uses the server's dynamic registration endpoint.
`--callback-port` selects a fixed local callback port; `--timeout` bounds the sign-in (default 900 seconds). With
`--client-id`, the callback path is always `/mcp/oauth/callback`. Register
`http://127.0.0.1:<callback-port>/mcp/oauth/callback` in advance and choose that port when exact redirect matching is required.
Omitting the port requires a service that permits variable loopback ports. Dynamically registered clients keep a random
callback path. Both modes require a fresh state and PKCE challenge and accept a callback only once.

Discovery first probes the MCP resource without credentials and uses its `WWW-Authenticate` `resource_metadata` hint.
Without a hint, the SDK discovers the default well-known metadata. An unusable or ambiguous hint is refused, never
silently replaced by default discovery. Login, opening a bound client and refresh share this discovery path.

The browser callback binds only `127.0.0.1`. For a remote CLI, run it with a fixed callback port and forward that port to
the browser's machine. An automatic `mcp login --deployment` relay is not provided. A local Kage grant is never copied into
a deployed instance. Prepare the target's authorization separately, or use its own static credentials.

Default grants live in the selected `.secrets/mcp-auth.json`; instance bindings are under the state root in
`mcp-bindings.json`. Grant writes are atomic and owner-readable; symlink aliases lock the same backing file. Before a
managed grant write, FastAgent prepares the owned secrets directory's `.gitignore`, using the same rule as value files.
An unprotected `FASTAGENT_SECRETS_DIR` override produces a warning rather than an ignore file in the operator's directory;
explicit `mcpGrantFile(path)` stores remain the host's responsibility. Git ignores do not untrack already committed files.
A completed login saves the grant before changing the
binding. Reopen a running agent to use a changed binding; sign-in does not hot-swap the identity of active calls.

```bash
# Stop the serving instance first; disconnect refuses while its storage is held.
fastagent mcp disconnect linear --json
```

Disconnect removes only this instance's binding. It does not delete or revoke a grant another instance may use. Update
`.mcp.json` or authorize again before reopening a required server. Remote revocation is an action in the provider's
account settings; local deletion or client close is not evidence of revocation.

## Embedding in Kage or another app

The root package exports `inspectMcp`, `signInMcp`, `mcpGrantFile`, `McpError`, and the `Mcp*` types from `src/mcp-api.ts`.
No MCP SDK types are required by an embedding host.

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

// Persist this choice in the host's instance record, not in .mcp.json.
const mcp = { store, bindings: { linear: grant.id } };
const state = await inspectMcp(agentDir, mcp);
const agent = await openAgent(definition, { workdir, stateDir: instanceStateDir, mcp });
```

The callback functions in this example belong to the host UI. `confirmAuthorization` receives the server, resource,
issuer and scopes and returns a boolean. `notify` receives either `auth_url` or `progress`; the host opens the system
browser and displays progress. Authorization can be performed before the harness is open. Neither open nor a background
tool call launches a browser implicitly.

A host can supply its own `McpGrantStore`, for example over encrypted application storage. Its `withGrant` operation must
serialize every caller sharing a grant, including distinct store objects. Writes inside the scope must be durable as
soon as they resolve, and must not roll back if a later step fails. See the [grant-store contract](design/mcp-auth.md).
`list()` exposes summaries, while `read()` and the exclusive access methods handle secret records and belong only in the
trusted host process. There is no automatic global-account fallback.

`mcp.variables` supplies instance-local interpolation overrides. `mcp.fetch` supplies a fetch-compatible network policy.
If a custom `store` or `bindings` is supplied, both are required. Two agents can explicitly share a grant while keeping
separate clients; two accounts at the same endpoint have different grant IDs. Even two opens of the same definition with
different `stateDir` values have independent clients and interpolation values. Closing A does not close B or sign it out.

## Cancellation, refresh and recovery

- Tool cancellation forwards the invocation's abort signal. Servers may ignore cancellation; it does not undo effects.
- Refresh is serialized under the grant store's exclusive access. A durable marker precedes the request; the rotated
  credentials are saved before use. Two 401 responses for one token generation reuse a newer saved generation.
- A refresh with an uncertain outcome is not replayed with the old token. Sign in explicitly again; network errors do not
  silently trigger browser login or scope expansion.
- A canceled waiter cannot discard a rotation already in progress. Instance close joins its refresh work before releasing
  clients. A process lost during refresh may conservatively require another authorization.
- MCP tools keep the harness's `unsafe` replay policy: interruption is reported, not silently rerun after restart.
- A disconnected client is not silently reconnected mid-call. Reopen the agent to reconstruct it.
- Open failure closes clients already acquired and releases the instance's storage lease. Close reports cleanup failures.

Discovery/auth network operations have a 30-second request budget; tool calls have a 60-second budget. Unsupported content
(such as images or resource links) is a visible tool error, not silently removed. MCP stdio stderr is drained but not
forwarded verbatim because it can contain supplied credentials. Connection errors include the server, known OS/DNS/TLS
codes, HTTP status and SDK classification when available. For example, `ENOENT` distinguishes a missing executable/path
from `CONNECTION_CLOSED` during protocol discovery. Only allowlisted facts from error causes are exposed; original
messages, paths, arguments, response data and cause objects remain private.
The SDK probes stdio protocol support in a short-lived sibling process before starting the serving process, so server
startup can run twice. Do not put irreversible business work in server startup.

`dev` restarts on `.mcp.json` edits after active turns drain. The file travels in the deployment image; a kept Docker
ignore file that excludes it is refused. MCP credential files remain in `.secrets`, never in the image. Package/runtime
dependencies for local servers must be declared in the agent's package/environment for the target machine.
