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
- File location does not own resources. Each opened agent instance owns its clients and resolved bindings.
  OAuth grants persist beyond open/close in a credential store controlled by the host; clients are never cached globally
  by server name or agent-directory path, and credentials are never implicitly shared between agents.
- The first release includes **stdio and Streamable HTTP, including OAuth**. Browser sign-in is a core Kage workflow,
  not a later enhancement or a request for the person to copy tokens into files.
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

Use JSON for local stdio servers and remote Streamable HTTP servers. For example:

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
    },
    "workspace-service": {
      "type": "http",
      "url": "https://mcp.example.com/mcp"
    }
  }
}
```

`http` means Streamable HTTP, not the retired HTTP+SSE transport. An OAuth server can be declared by URL alone when
its discovery and client-registration requirements permit it. Tokens and granted account identity are not configuration.

The environment entry illustrates a secret reference; the filesystem server itself needs no token.

| Field | First-slice meaning |
|---|---|
| `mcpServers` | A map from stable server names to declarations |
| `type` | `stdio` or `http`; omission means stdio when `command` is present |
| `command` | stdio only: a non-empty executable name or path, not a shell expression |
| `args` | stdio only: an array of strings, empty when omitted |
| `env` | stdio only: server-specific string environment values; secrets use references |
| `url` | HTTP only: the MCP endpoint |
| `headers` | HTTP only: static header values may reference secrets; do not combine an explicit Authorization header with OAuth |

Some services need a pre-registered client ID or explicit scope selection. Finalize the non-secret OAuth configuration
subset against a real target service; do not invent a universal field shape or store client secrets in the definition.

A missing file declares no servers. Malformed JSON, unknown fields, unsupported transports and unresolved variable
references fail with the file, server and field named. Do not guess another format or silently ignore unsupported fields.
Do not scan parent directories, `.pi/mcp.json`, editor settings or home-directory MCP files.

Proposed interpolation is `${NAME}` in string values of `command`, `args`, `env` and HTTP `headers`, resolved from this instance's effective
environment. Interactive `${input:...}`, command substitutions and default-value syntax are outside this first subset;
reject them explicitly. Do not change `process.env`. Use the existing selected-environment/secret mechanisms and include
referenced required variables in preflight diagnostics without printing their values. Hosts needing credentials not
represented by that environment use explicit host credential bindings, not a second server-definition source. OAuth
access/refresh tokens are resolved from the grant store, never by expanding them into the shareable file.

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

The current-protocol target is **2026-07-28**, with the v2 TypeScript client SDK. It has been exercised with local stdio
servers and the real Linear OAuth/HTTP service below. This supports the target, not a claim of universal server
compatibility or completed FastAgent integration. Its core is request-scoped:
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
The experimental pin refuses a server restricted to the old era; that is probe behavior, not yet a product policy.
Any broader supported-version negotiation must be explicit, observable and handled by the SDK, not invented as a fallback
after arbitrary network or authorization errors.

This probe is **SDK-level evidence only**. The earlier full pi-durable lifecycle spike in #678 negotiated **2025-11-25**.
Repeat the relevant cancellation, interruption/reopen and multi-instance tests with the selected SDK and public FastAgent
assembly before shipping. Do not promote the old connection-local logging-toggle behavior into a new protocol guarantee.

### Linear HTTP/OAuth interoperability

On 2026-11-01, a disposable client using `@modelcontextprotocol/client@2.4.0` connected to Linear's official
`https://mcp.linear.app/mcp/readonly` endpoint through the machine's configured HTTP proxy. This was SDK-level testing,
not a Kage or FastAgent feature implementation. The operator completed browser authorization; no token/code was pasted
into the conversation. The experiment recorded only protocol/status information, not returned team data.

| Check | Observed result |
|---|---|
| Discovery and registration | Protected resource and issuer metadata matched; dynamic registration accepted a native client with a loopback callback and PKCE S256 |
| Browser callback | State and the advertised RFC 9207 issuer were checked; tokens persisted atomically to an owner-readable temporary file (`0600`) |
| Granted scope | `read`, with a refresh token; the reported access-token lifetime was 86100 seconds |
| Protocol and tools | Explicit 2026-07-28 pin connected in the modern era; 38 tools were listed |
| Tool call | `list_teams` with `limit: 1` returned successfully; no writes to Linear business data |
| New process | A separate Node process loaded the saved grant and called the same tool without registration or browser authorization |
| Refresh | One explicit refresh request succeeded; both access and refresh tokens rotated, scope stayed `read`, and the replacement grant worked immediately and in another new process |
| Two clients | Two independent clients deliberately used the same grant; closing A left B able to call the tool, and did not change the persisted grant |

Linear's initial 401 challenge on this read-only URL advertised `scope="read write"`, while its protected-resource
metadata advertised only `read`. An explicit authorization request for `read` succeeded and the resulting grant served
all tested reads. Do not silently broaden scopes from a challenge, and do not turn this service-specific observation
into a general rule to disregard scope requirements. The host needs a scope-consent boundary.

The test used an explicit SDK `refreshAuthorization` call, not a wait for natural expiry or the transport's automatic
401 recovery. Proactive expiry handling, concurrent refresh, failed/denied authorization, reauthorization, remote
revocation, distinct accounts and FastAgent/Kage multi-instance wiring remain acceptance work. Two SDK clients sharing
one grant are not proof of two isolated agent instances or two accounts.

## 5. Ownership and capability scope

| Concern | Owner |
|---|---|
| Which servers the agent uses | `.mcp.json` in the definition |
| Secret values and local execution environment | The selected instance/deployment or its embedding host |
| Durable OAuth grants and refresh coordination | A host-controlled store; each instance has an explicit grant binding |
| Consent to execute the definition and expose data | The person or embedding host |
| Clients, transports, subprocesses and cleanup | Each open agent instance |
| Server business data, explicit handles and their durability | The MCP server and its backing service |

For Kage, two `openAgent` calls in one Electron process must construct independent client sets, including when they open
the same definition with different `stateDir` values. Closing or failing one must not close the other's clients. Loading
an ES module once is not permission to share the resources it creates. Sessions within one instance may share the same
server and its state; this is explicit, not a session-isolation guarantee.

The first slice exposes tool discovery and invocation, input validation, text/JSON results, progress/cancellation and
observable errors. Do not advertise capabilities that are not implemented. Unsupported result content must be reported,
not silently filtered out. Streamable HTTP includes unauthenticated, static-token and OAuth-protected servers.
Resource/prompt browsing, sampling, elicitation, tasks, legacy HTTP+SSE, live tool-list updates and server-private
per-session isolation are outside this slice. Reopening may refresh the declared tool snapshot.

Keep the existing `unsafe` replay default. Read-only/idempotency annotations alone do not authorize replay. An ambiguous
in-flight failure is not retried silently. Cancellation stops the caller's request and signals the server; it does not
prove remote work stopped or undo side effects. Closing an instance explicitly joins client cleanup; a failed open cleans
up clients already acquired, and cleanup failures remain diagnosable.

## 6. OAuth is part of the first release

The required Kage experience is: choose a server, click Connect, authorize in the system browser, return to Kage, and use
its tools. Reopening Kage reuses a still-valid grant; expiry refreshes without asking the person to paste a token.
A denied, canceled or expired authorization reports its own result and never claims a connection succeeded.

Follow the [MCP authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization):
HTTP resource/authorization-server discovery, authorization code with PKCE S256, state and issuer validation,
resource/audience binding, and secure token storage. Stdio remains an environment-credential transport; MCP HTTP OAuth
does not log arbitrary child programs in.

### Host-facing boundary

Kage must be able to inspect auth status, start/cancel sign-in and disconnect without first opening a fully authenticated
agent. Opening an agent or executing an unattended tool must not secretly launch a browser or wait indefinitely for a
person. An explicit host interaction drives browser/callback steps; CLI use adapts the same flow to its ticket model.
Auth-required and insufficient-scope outcomes must name the server and reach the host as actionable structured results.
The exact public host types and method names need review before implementation.

FastAgent owns protocol/authentication mechanics and their consistent outcomes; Kage owns presentation, the system-browser
action and where credentials are stored. The host contract stays in FastAgent's types, without exposing MCP SDK internals.
The existing model-provider `CredentialStore`/`signIn` API is keyed by provider and cannot simply be reused as an MCP
grant model. Reuse established interaction and atomic-write patterns where they fit, not the provider-keyed identity.

### Grants and isolation

The store must distinguish the resource server, validated authorization-server issuer, client registration, granted
scopes and selected account/opaque grant identity. A display name such as `notion` or `github` is not an auth key, and an
access token must not be decoded to guess the user's identity. Exact store interfaces and key encoding remain to be designed.

Grant reuse across agents must be an explicit host/user binding. An agent's `close()` releases clients but does not sign
the user out. Disconnecting one binding must not revoke or delete a grant still used by another agent. A whole-grant
sign-out must make its impact clear; distinguish local removal from confirmed remote revocation when supported.
Allow separate accounts for the same MCP endpoint.

Serialize refreshes per grant, including rotated refresh-token persistence, rather than per client instance. A concurrent
refresh must not overwrite or reuse a rotated token. Refresh refusal/expiry becomes a reauthorization requirement; a
network failure remains a network failure. Changed issuers/resources, conflicting authentication modes and mismatched
callbacks must fail visibly, not reuse a nearby credential.

Credentials and pending-flow secrets stay outside `.mcp.json`, source control, model context, transcript and logs.
A host can supply secure storage; CLI storage must be owner-readable and atomic. Use the system browser and a validated
native callback path; do not require a user to paste an authorization code into an agent conversation.

### Interoperability before implementation

Use the SDK's OAuth machinery rather than build a second OAuth protocol stack. Verify resource metadata discovery and
authorization-server discovery, registration selection (pre-registration or Client ID Metadata Documents; DCR only when a
chosen service needs it), callback constraints, refresh and scopes against an actual Kage target service. Do not assume
every service supports dynamic registration or arbitrary localhost redirect URIs.

For cloud instances, authorization is bound to the deployed instance's store, not silently copied from Kage's account.
Before claiming deploy OAuth support, define how the person's browser completes that remote instance's flow. The
loopback callback used by local Kage does not solve that boundary by itself.

Protocol-authorized refresh/re-authorization after an authentication rejection is distinct from replaying an ambiguous
tool call. Never replay an operation after a timeout/disconnection that may have happened after its side effect.

## 7. Implementation gates

Before the feature is marked supported:

- Define the exact parser/interpolation contract, namespacing and supported schema/result mappings; verify representative
  Claude/Copilot-style stdio and HTTP entries, and explicit rejection of unsupported forms.
- Verify two agents in one process: different secrets/paths, independent clients, failed-open cleanup, and closing one while
  the other continues. Include two opens of the same directory with separate state.
- Verify SDK discovery/serving process cleanup, HTTP cancellation/disconnection, and restart through the public assembly.
- Verify OAuth discovery, browser sign-in/cancel/denial, restart persistence, refresh rotation and concurrent refresh,
  insufficient scope, issuer/resource changes, two accounts at one endpoint and explicit cross-agent grant bindings.
- Complete a real Kage-style browser OAuth flow against a target MCP service and call a tool; a fake authorization server
  is necessary for regressions but does not substitute for this interoperability acceptance. The Linear SDK-only flow
  above establishes the service baseline; repeat it through the implemented host API.
- Confirm `.mcp.json` is shipped and inspected consistently by open/dev/start/deploy, with no copied credentials.
- Verify the claimed runtime matrix with the selected dependency before publishing; the new-protocol probe covered Node
  26.11.1 on macOS, not Bun, Windows or a cloud deployment.

Track implementation and evidence in [#678](https://github.com/fastagent-sh/fastagent/issues/678). Context package
composition can be designed later without creating a second declaration format for these servers.
