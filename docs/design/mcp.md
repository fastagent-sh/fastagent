---
title: MCP servers
description: "The MCP configuration boundary: one .mcp.json, a supported subset of mcpServers, and instance-owned runtime resources."
type: design-doc
status: decided boundary; implementation pending
---

# MCP servers

The configuration boundary below is decided. MCP support is not implemented yet
([#678](https://github.com/fastagent-sh/fastagent/issues/678)); the first-slice contract and protocol target below
are the implementation proposal to verify before shipping. They do not change the consumer [Agent API](../SPEC.md).

## 1. Decided boundary

- Call the feature **MCP servers**. There is no generic `Connector` interface or configuration kind.
- The agent directory's **`.mcp.json`**, with a top-level **`mcpServers`** map, is the one configuration source.
  Do not also define servers in `context.json`, `fastagent.config.ts`, or a machine-wide MCP configuration.
- File location does not own resources. Each opened agent instance owns its clients, resolved paths and credentials;
  nothing is cached globally by server name or agent-directory path.
- Choose and test the protocol revision and supported capability/configuration subset before implementation.
  Registry publishing, MCPB installation and context packages are not prerequisites.

A separate file lets authors reuse familiar project configuration without translating it into a FastAgent-specific
`context.json.connectors` shape. A directory can carry several standard formats without becoming several definitions.
`context.json` continues to own content and environment declarations.

## 2. What is standardized

MCP standardizes host/client/server roles and protocol capabilities, not a universal configuration file for all hosts.
Claude Code and Copilot's portable configuration use `.mcp.json` / `mcpServers`; Cursor and VS Code have other locations
and, in VS Code's own format, a different `servers` key. Their interpolation and authorization behavior also differ.
FastAgent must name its supported subset rather than claim complete compatibility with every client.

[SEP-2633](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2633), the proposal for a standard client
`mcp.json`, was still Draft when checked on 2026-11-01. Its proposed shape is not an adopted standard to implement blindly.
[Registry `server.json`](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/generic-server-json.md)
describes distribution and configuration possibilities; [MCPB manifests](https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md)
describe installable server bundles. Neither is an agent's resolved server configuration.

## 3. First configuration subset: proposal

Start with JSON and stdio tools. A minimal example is:

```json
{
  "mcpServers": {
    "project": {
      "type": "stdio",
      "command": "node",
      "args": ["./node_modules/@modelcontextprotocol/server-filesystem/dist/index.js", "./content/project"],
      "env": {
        "SERVICE_TOKEN": "${SERVICE_TOKEN}"
      }
    }
  }
}
```

The environment entry illustrates a secret reference; the filesystem server itself needs no token.

| Field | First-slice meaning |
|---|---|
| `mcpServers` | A map from stable server names to declarations |
| `type` | `stdio`; omission means stdio when `command` is present |
| `command` | A non-empty executable name or path, not a shell expression |
| `args` | An array of strings, empty when omitted |
| `env` | Server-specific string environment values, empty when omitted; secrets use references |

A missing file declares no servers. Malformed JSON, unknown fields, unsupported transports and unresolved variable
references fail with the file, server and field named. Do not guess another format or silently ignore unsupported fields.
Do not scan parent directories, `.pi/mcp.json`, editor settings or home-directory MCP files.

Proposed interpolation is `${NAME}` in string values of `command`, `args` and `env`, resolved from this instance's effective
environment. Interactive `${input:...}`, command substitutions and default-value syntax are outside this first subset;
reject them explicitly. Do not change `process.env`. Use the existing selected-environment/secret mechanisms and include
referenced required variables in preflight diagnostics without printing their values. Hosts needing credentials not
represented by that environment need an explicit instance-binding API decision, not a second server-definition source.

Resolve command paths relative to the agent directory; bare executable names use that instance's PATH. Spawn with the
agent directory as cwd and pass arguments verbatim, without a shell. Relative path arguments then follow the server's
normal cwd rules; FastAgent must not guess which arbitrary arguments are paths. Do not depend on the embedding app's cwd.
The server environment must not receive every other provider/server secret merely because the agent knows it; finalize
and test the inherited-variable allowlist and explicit overrides during implementation.

An MCP declaration is authority to run code or contact a service. The author or embedding host must explicitly trust the
definition before opening it; do not treat a downloaded configuration as passive data or promise a sandbox that does not
exist. Do not write secret values or machine-specific grants into the distributable definition. The directory artifact
carries `.mcp.json`; dependencies belong to the agent's package/environment, not a new MCP installer.

## 4. Protocol target and evidence

The first implementation target is **2026-07-28**, with the v2 TypeScript client SDK. Its core is request-scoped:
`server/discover` and request metadata replace the old `initialize` handshake. Explicit server handles, not FastAgent
session ids or a transport connection, identify cross-call server state. See the
[protocol changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog).

A follow-up probe on 2026-11-01 used `@modelcontextprotocol/client@2.4.0` with the official Filesystem and Everything
servers at 2.1.0. Explicit `versionNegotiation: { mode: { pin: "2026-07-28" } }` connected in the modern era, listed tools,
read/wrote a disposable file, canceled a long call, called another tool afterward, and closed all observed child processes.
The SDK's default still used the legacy era; importing v2 alone is not proof of the selected protocol.

The SDK's own stdio transport performs discovery in a disposable sibling process and then starts the serving process:
two starts per connection were observed. Startup side effects and both children belong in acquisition/cleanup tests.
Do not bypass the SDK's detection with type casts, invent a cached discovery verdict, or describe this as one process
start. Before adopting the dependency, verify open failure, probe failure and close during discovery leave no children.
A server restricted to the old era is refused by the pinned policy; no product-level silent downgrade is planned.

This probe is **SDK-level evidence only**. The earlier full pi-durable lifecycle spike in #678 negotiated **2025-11-25**.
Repeat the relevant cancellation, interruption/reopen and multi-instance tests with the selected SDK and public FastAgent
assembly before shipping. Do not promote the old connection-local logging-toggle behavior into a new protocol guarantee.

## 5. Ownership and capability scope

| Concern | Owner |
|---|---|
| Which servers the agent uses | `.mcp.json` in the definition |
| Secret values and local execution environment | The selected instance/deployment or its embedding host |
| Consent to execute the definition and expose data | The person or embedding host |
| Clients, transports, subprocesses and cleanup | Each open agent instance |
| Server business data, explicit handles and their durability | The MCP server and its backing service |

For Kage, two `openAgent` calls in one Electron process must construct independent client sets, including when they open
the same definition with different `stateDir` values. Closing or failing one must not close the other's clients. Loading
an ES module once is not permission to share the resources it creates. Sessions within one instance may share the same
server and its state; this is explicit, not a session-isolation guarantee.

The first slice exposes tool discovery and invocation, input validation, text/JSON results, progress/cancellation and
observable errors. Do not advertise capabilities that are not implemented. Unsupported result content must be reported,
not silently filtered out. Resource/prompt browsing, sampling, elicitation, tasks, OAuth, HTTP/SSE transports, live tool-list
updates and server-private per-session isolation are outside this slice. Reopening may refresh the declared tool snapshot.

Keep the existing `unsafe` replay default. Read-only/idempotency annotations alone do not authorize replay. An ambiguous
in-flight failure is not retried silently. Cancellation stops the caller's request and signals the server; it does not
prove remote work stopped or undo side effects. Closing an instance explicitly joins client cleanup; a failed open cleans
up clients already acquired, and cleanup failures remain diagnosable.

## 6. Implementation gates

Before the feature is marked supported:

- Define the exact parser/interpolation contract, namespacing and supported schema/result mappings; verify representative
  Claude/Copilot-style stdio entries and explicit rejection of unsupported forms.
- Verify two agents in one process: different secrets/paths, independent clients, failed-open cleanup, and closing one while
  the other continues. Include two opens of the same directory with separate state.
- Verify SDK discovery/serving process cleanup, cancellation, disconnection and restart through the public assembly.
- Confirm `.mcp.json` is shipped and inspected consistently by open/dev/start/deploy, with no copied credentials.
- Verify the claimed runtime matrix with the selected dependency before publishing; the new-protocol probe covered Node
  26.11.1 on macOS, not Bun, Windows or a cloud deployment.

Track implementation and evidence in [#678](https://github.com/fastagent-sh/fastagent/issues/678). Context package
composition can be designed later without creating a second declaration format for these servers.
