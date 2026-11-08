---
title: MCP servers
description: "The MCP configuration boundary: mcpServers in context.json and fastagent.json, a supported subset, and instance-owned runtime resources."
type: design-doc
status: implemented subset
---

# MCP servers

The [MCP guide](../mcp.md) describes the implemented stdio/Streamable HTTP tool subset and OAuth flow
([#678](https://github.com/fastagent-sh/fastagent/issues/678)). This note records the decisions and evidence behind it.
The consumer [Agent API](../SPEC.md) sessions/messages are unchanged.

## 1. Decided boundary

- Call the feature **MCP servers**. There is no generic `Connector` interface or configuration kind.
- The program's servers are the **`mcpServers`** map of its `context.json`, published with it. An instance adds its own
  under `mcpServers` in its `fastagent.json`, the same entry shape, layered on the program's and never replacing it: a
  name in both refuses the open. One reader gives every consumer the same list (`declareMcp`). FastAgent reads and
  writes no `.mcp.json`, the file the coding tools keep for the person working in a directory ([artifact
  design](agent-artifact.md) §3.3). Do not also define servers in `fastagent.config.ts` or a machine-wide MCP configuration.
- File location does not own resources. Each opened agent instance owns its clients and resolved bindings.
  OAuth grants persist beyond open/close in a credential store controlled by the host; clients are never cached globally
  by server name or agent-directory path, and credentials are never implicitly shared between agents.
- The first release includes **stdio and Streamable HTTP, including OAuth**. Browser sign-in is a core CLI/embedding
  workflow, not a later enhancement or a request for the person to copy tokens into files.
- The protocol/configuration subset is implemented in #895 and documented in the [guide](../mcp.md).
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

## 3. First configuration subset

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

Interpolation is `${NAME}` in string values of `command`, `args`, `env` and HTTP `headers`, resolved from this instance's effective
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
carries the program's `mcpServers` in `context.json`; dependencies belong to the agent's package/environment, not a new MCP installer.

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
The implementation pins this revision and refuses an older-only server. Any future broader supported-version policy
must be explicit and SDK-owned, not a fallback after arbitrary network or authorization errors.

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
| Which servers the agent uses | The program's `context.json` `mcpServers`, and the instance's `fastagent.json` `mcpServers` |
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

The required host workflow is: choose a server, start sign-in, authorize in the system browser, return to the CLI or app,
and use its tools. Reopening reuses a still-valid grant; expiry refreshes without asking the person to paste a token.
A denied, canceled or expired authorization reports its own result and never claims a connection succeeded.

Follow the [MCP authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization):
HTTP resource/authorization-server discovery, authorization code with PKCE S256, state and issuer validation,
resource/audience binding, and secure token storage. Stdio remains an environment-credential transport; MCP HTTP OAuth
does not log arbitrary child programs in.

### Host API, grants and refresh ownership

The [authorization contract](mcp-auth.md) separates server declarations, opaque grant IDs and host-owned instance
bindings. It defines `inspectMcp` / `signInMcp`, the `openAgent` binding input, a CLI file adapter and the store's
exclusive-access contract. These operations are exported from the root entry; their types live in `src/mcp-api.ts`.

Kage owns presentation, the system browser and credential storage. FastAgent owns protocol/auth mechanics, scope-consent
requests and the local callback. Auth setup can run before the harness opens; ordinary open/tool calls cannot launch a
browser implicitly. The existing model-provider credential API is not used as the MCP grant key space.

The store owns serialization for every caller sharing a grant. It permits durable writes while holding exclusive access:
a refresh marker is saved before the remote token may be consumed, and replacement tokens before they are returned.
Canceled waiters do not discard completed rotation; uncertain refresh outcomes require explicit recovery, not replay of an
old token. Two 401s for one token generation reuse the newer committed generation.

An agent close releases its clients only. Binding removal, whole-grant forgetting and remote revocation are distinct
actions. Interactive sign-in creates a fresh grant rather than silently replacing one other agents may use. Detailed
state transitions, tradeoffs and the controlled concurrency experiment are in [mcp-auth.md](mcp-auth.md).

### Interoperability boundaries

Use the SDK's OAuth machinery rather than build a second OAuth protocol stack. Verify resource metadata discovery and
authorization-server discovery, registration selection (pre-registration or Client ID Metadata Documents; DCR only when a
chosen service needs it), callback constraints, refresh and scopes against an actual MCP service used through FastAgent. Do not assume
every service supports dynamic registration or arbitrary localhost redirect URIs.

For cloud instances, authorization is bound to the deployed instance's store, not silently copied from Kage's account.
Before claiming deploy OAuth support, define how the person's browser completes that remote instance's flow. The
loopback callback used by local Kage does not solve that boundary by itself.

Protocol-authorized refresh/re-authorization after an authentication rejection is distinct from replaying an ambiguous
tool call. Never replay an operation after a timeout/disconnection that may have happened after its side effect.

## 7. Verification

The implemented subset is covered by `test/mcp-*.test.ts`, `test/cli-mcp.test.ts`, and the deployment/watcher checks.
The built public entry also passed a Node 26.11.1 and Bun 1.4.4 stdio two-instance smoke test on macOS. A real Linear
browser authorization through the CLI, public-agent calls, close isolation, forced-expiry refresh and new-process reuse
passed on 2026-11-02; see [authorization evidence](mcp-auth.md#6-evidence-and-remaining-validation).

Keep these gates when changing the subset:

- Define the exact parser/interpolation contract, namespacing and supported schema/result mappings; verify representative
  Claude/Copilot-style stdio and HTTP entries, and explicit rejection of unsupported forms.
- Verify two agents in one process: different secrets/paths, independent clients, failed-open cleanup, and closing one while
  the other continues. Include two opens of the same directory with separate state.
- Verify SDK discovery/serving process cleanup, HTTP cancellation/disconnection, and restart through the public assembly.
- Verify the [grant-store contract](mcp-auth.md): serialization across store objects, durable refresh markers, canceled
  waiters, interrupted writes and deletion/refresh races. Include two 401s for one token generation.
- Verify OAuth discovery, browser sign-in/cancel/denial, restart persistence, refresh rotation and concurrent refresh,
  insufficient scope, issuer/resource changes, two accounts at one endpoint and explicit cross-agent grant bindings.
- Complete a real browser OAuth flow against a target MCP service through the packed FastAgent CLI/public host API, then
  call a tool. A controlled authorization server is necessary for regressions but does not replace interoperability
  acceptance. Recheck current-transport interoperability when changing discovery, authorization or network policy.
- Confirm the program's `mcpServers` ship and are inspected consistently by open/dev/start/deploy, with no copied credentials.
- Verify the claimed runtime matrix with the selected dependency before publishing. Windows, actual Kage UI/secure storage
  and deployment OAuth relay have not been accepted; local loopback authorization does not prove those paths.
  Kage is a downstream consumer, not a release prerequisite or a substitute for the broader FastAgent scenario set.

### FastAgent-owned release acceptance

Use an installed FastAgent npm tarball, not a source-only SDK bridge. Run disposable agents and real server processes;
record the candidate commit, installed dependency versions, runtime, transport and observable result. Deterministic
models make lifecycle checks reproducible, but are not evidence of a real model choosing or executing tools.

| Scenario | Acceptance evidence |
|---|---|
| Author and CLI | Official Filesystem/Everything servers loaded from `mcpServers`; CLI invocation, workspace read/write, explicit unsupported-content/version refusals and secret-safe startup failures |
| Embedded hosts | Two `openAgent` instances, including one directory with distinct state/variables; independent clients, workspace restrictions and close isolation |
| Agent API service | MCP-backed messages through `connectAgent`; API-key refusal, persistent conversation ids and reads after restart |
| Real model | An authenticated provider performs MCP tool calls; verify successful `tool_result` entries and actual filesystem effects, not just the final answer |
| Cancellation and failure | Progress, cancel and another usable call; partial-open cleanup; a real process kill followed by interrupted-unsafe-call recovery without replay |
| HTTP and identities | Anonymous/static HTTP and wrong-token refusal; distinct and explicitly shared grants over real HTTP; controlled-issuer results labelled separately from real-provider results |
| Real OAuth and networking | Packed CLI/browser flow, durable/new-process reuse and refresh under the current transport; normal/proxy connectivity and explicit fake-IP/private-address refusal |
| Deployed runtime | A representative Linux/container host with its own mounted state/secrets and image-carried definition; MCP calls and restart persistence, without desktop-grant copying |

The [0.29.0 release](https://github.com/fastagent-sh/fastagent/releases/tag/v0.29.0) completed this matrix using a
tarball from candidate `56eddb70`, official Filesystem/Everything 2.1.0, pi 1.4.0, and a fresh installation resolving
Effect 4.1.1 / Undici 8.12.3. The final release gate passed 2066 tests with two skipped. CLI/HTTP/lifecycle scenarios used
deterministic models; separately, a real Codex model completed both MCP filesystem operations. Current-policy Linear
read-only OAuth passed directly, through an IP-pinned CONNECT proxy, and after container replacement with its state volume.
Distinct identities and concurrent refresh were checked with a controlled issuer over real HTTP, not multiple real accounts.

Two findings remain explicit in the evidence:

- [#896](https://github.com/fastagent-sh/fastagent/issues/896): provider-session resources can retain Codex's WebSocket
  and five-minute timer after agent close. The maintainer accepted this known limitation for 0.29.0; the fix remains open.
- The original x86-on-ARM startup failure left a time-matched ARM64 core with its PC in QEMU 7.0's allocator.
  It is classified as an emulator-native crash, not an unexplained MCP refusal. Native ARM64 passed 20 open/close
  cycles and five restarts; the exact QEMU trigger is unknown. Use native architecture as the accepted baseline.

Temporary probes, credentials, business-bearing state, containers, volumes, candidate images and the private diagnostic
core were removed at release closeout. Raw cores were not uploaded; Linear's remote authorization was not revoked.

Keep failed observations visible until explained or explicitly scoped as a known limitation. A later successful run does
not erase an earlier failed startup. Do not force process exit, disable network guards or increase timeouts to turn a
failure into acceptance. Third-party app UI tests, including Kage, are separate downstream integration work.

Track implementation, results and release readiness in [#678](https://github.com/fastagent-sh/fastagent/issues/678).
Context package composition can be designed later without creating a second declaration format for these servers.
