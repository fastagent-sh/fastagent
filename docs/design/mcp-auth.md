---
title: MCP authorization ownership
description: "Embedding contract for MCP grants, instance bindings, browser sign-in and durable refresh coordination."
type: design-doc
status: implemented
---

# MCP authorization ownership

This is the host/store contract for [MCP support](../mcp.md), following the real Linear OAuth check in
[#678](https://github.com/fastagent-sh/fastagent/issues/678). The exported types live in `src/mcp-api.ts`.
The consumer Agent API's sessions/messages remain unchanged. An embedding host owns its UI and persistence; FastAgent owns MCP/OAuth
mechanics and exposes its own types, without leaking SDK types into an embedding application.

## 1. Three identities, three owners

| Identity | Meaning | Owner |
|---|---|---|
| Server name | A declaration in `mcpServers`, such as `linear`; not a credential key | Agent definition or instance |
| Grant ID | An opaque ID allocated for one completed authorization, not an account ID inferred from a token | Grant store |
| Binding | This instance chooses this grant for this declared server | Embedding host, or CLI instance state |

The resource URI, exact validated issuer, client registration and granted scopes are stored with the grant and checked
before use. Server aliases, directory paths and a provider name alone are insufficient. Two accounts at one endpoint have
different grant IDs. Account labels supplied by a person are display data, not proof of identity. Never decode a token to
guess who owns it.

Kage may explicitly bind two agents to one grant. That shares authorization and refresh coordination, not MCP client
objects. Different `openAgent` calls create different clients, including two opens of the same definition. Closing one
agent does not delete or revoke its grants. An unrelated instance never inherits a grant just because its server name or
URL matches.

Bindings are instance input, not a second source of server declarations. Kage stores them in its own instance records;
the CLI keeps its bindings outside the definition. A supplied store/bindings pair replaces the default, with no fallback
to a global user's account. The first implementation snapshots bindings at open. To change a live binding, the host closes
and reopens the affected instance; no hidden hot-swapping of credentials under an in-flight tool call.

## 2. Host operations

| Operation | Result and responsibility |
|---|---|
| `inspectMcp(agentDir, { store, bindings })` | Read declarations and local binding/grant metadata without opening the harness. Return server names, transport and local authorization state, never token values. This is not a network health check |
| `signInMcp({ agentDir, server, store, scopes, interaction })` | Discover the resource/issuer, obtain scope consent, run browser authorization, durably store a fresh grant and return its non-secret summary. Does not bind it to an agent automatically |
| `mcpGrantFile(path)` | The CLI/default file implementation of the grant-store contract below; no global fallback |
| `openAgent(dir, { stateDir, mcp: { store, bindings } })` | Resolve the named grants for this instance, validate their targets and open clients. Never launches browser login implicitly |

A binding map is `Readonly<Record<string, string>>`: declared server name to opaque grant ID. MCP declarations remain
solely in `mcpServers` (the program's `context.json`, the instance's `fastagent.json`); the host does not pass a second map of commands or URLs.

`inspectMcp` reports local authorization separately from connectivity: no binding, usable locally, refresh needed,
reauthorization needed, or binding mismatch. An unreadable/corrupt store rejects; it is not an empty store. A locally
usable grant may still be refused by the server later.

The sign-in interaction offers structured `confirmAuthorization({ server, resource, issuer, scopes })`, browser/progress
notifications and cancellation. It does not request a token or manual authorization code. FastAgent owns a validated
loopback callback for local sign-in; Kage opens the system browser. CLI tickets translate the same interaction for the
person. A deployed-instance sign-in still needs an explicit callback/relay design before deploy OAuth is claimed.

A requested wider scope requires a new consent step; no implicit union followed by browser launch during a background
call. A smaller caller-approved scope can be attempted, as the Linear read-only check demonstrated. If it is insufficient,
report that fact without silently escalating.

Each interactive sign-in creates a new grant rather than replacing a grant other agents may use. A durable save happens
before the result is returned. If the host fails to save its subsequent binding, the grant remains recoverable through
non-secret grant listings. The host explicitly chooses whether one or several instances adopt it.

Cancellation is accepted while waiting for browser approval. Once an authorization code is being exchanged, complete the
bounded exchange/save step rather than discard credentials after the server may have consumed the code. The UI must
present that phase as finishing, not promise rollback. A process lost during exchange starts a new sign-in; it does not
replay the old code.

## 3. Store contract: exclusive access with durable writes

A single async `modify(current) -> next` callback is insufficient: it can serialize refreshes, but cannot persist a marker
before the remote refresh token is consumed. The primitive is an exclusive per-grant operation with explicit
writes inside it:

```ts
interface McpGrantStore {
  read(grantId: string): Promise<McpGrantRecord | undefined>;
  list(): Promise<readonly McpGrantSummary[]>;
  withGrant<T>(
    grantId: string,
    operation: (grant: McpGrantAccess) => Promise<T>,
  ): Promise<T>;
}

interface McpGrantAccess {
  read(): McpGrantRecord | undefined;
  write(record: McpGrantRecord): Promise<void>;
  remove(): Promise<void>;
}
```

`withGrant` must be exclusive across every caller that shares the underlying store, even if they use different store
objects. CLI file storage resolves file/symlink targets before taking the existing `withLockedFile` lock and uses atomic replacement;
a Kage-backed store provides the corresponding serialization for its storage. A storage-wide lock is correct but may
serialize unrelated grants. No process-global singleton lock is substituted for the store contract.

Every `write` is durable before it resolves; every reader sees either a complete previous record or a complete new one.
Writes made before the operation throws **remain committed**. This is an exclusive-access scope, not a transaction that
rolls back every write on error. Do not hold the scope while waiting for browser/user input. Store adapters must surface
read/write/lock failures, and must never retry the operation callback automatically because it may make a remote call.

`McpGrantRecord` is FastAgent-owned, versioned data: resource URI, issuer, client registration, granted scopes, credential
values, token expiry when supplied, token generation and refresh state. Credential fields are secret and only the host
storage/protocol adapter reads them. `McpGrantSummary` omits all tokens, client secrets, codes and PKCE values. `src/mcp-api.ts` defines the record fields; `src/mcp/grants.ts` validates persisted records without echoing credential values.

## 4. Refresh protocol

Within exclusive access to the grant:

1. Read the current record and validate its resource/issuer/scope against the instance's binding. Missing or mismatched
   grants stop before any token is sent.
2. Return a still-usable token. For a 401, pass the generation that was refused: if another caller has already committed
   a newer usable generation, use that instead of refreshing again.
3. Persist `refreshing` **before** sending a refresh request. A later holder that finds this marker after acquiring the
   lock knows the previous operation did not commit a conclusive result; it must not reuse the old refresh token.
4. Call the SDK's refresh operation with its own bounded deadline. Persist the complete successful response and increment
   the token generation before returning any new access token. Preserve an unchanged refresh token only when the OAuth
   response legitimately omits a replacement.
5. A conclusive credential refusal requires reauthorization. An ambiguous network failure or failed post-refresh write
   retains the uncertainty marker and surfaces its actual error. Do not silently retry a possibly consumed token or
   turn a network fault into an automatic interactive login.

Canceling a message stops that caller's wait, not the shared refresh operation once step 3 has begun. The operation finishes
and saves for the other holders. Otherwise a cancellation between the remote rotation and the local write destroys the
only usable refresh token. Before step 3, a canceled caller need not start work. The initiating instance tracks and joins
any refresh it started during close, with the refresh's bounded deadline; no detached refresh is abandoned on graceful
shutdown, and closing a different instance does not cancel it.

A marker may conservatively require a new sign-in even when the server never received a request. This is an explicit
availability tradeoff: without a server idempotency/recovery guarantee, a client cannot distinguish that case from a lost
successful response. This is not exactly-once OAuth refresh.

Use explicit SDK calls for this boundary. The SDK's higher-level auth helper can choose a new browser flow after a refresh
failure; a host must not accidentally adopt that policy for background token resolution.

## 5. Disconnect and forgetting

- **Close an agent:** release its clients, not grants or other agents' clients.
- **Disconnect one binding:** close the affected instance, remove its chosen binding, then let the host explicitly reopen
  or finish configuration. Do not change another binding or delete a shared grant. Required-server auth failures remain
  visible on a subsequent open; this operation does not silently remove the declaration.
- **Forget a grant:** an explicit action affecting all bindings to that grant. The host identifies affected instances and
  stops their use before calling `remove` under the same exclusive scope as refresh. A late refresh cannot resurrect it.
- **Remote revocation:** distinct from forgetting a local record. Do it only through an explicit supported operation and
  report confirmed success/failure separately. Client close and local deletion are not evidence of server revocation.

No reference-counted automatic deletion or background account discovery is needed. The host already owns instance
bindings and can show the scope of a grant-level action.

## 6. Evidence and remaining validation

A disposable Node experiment on 2026-11-01 combined the existing `withLockedFile`/`writeFileAtomic` with the real SDK
`refreshAuthorization` function and a controlled, single-use-refresh-token endpoint implemented as a fetch double.
No real credentials or external requests were involved. Eleven checks passed:

- two independent store objects using one grant caused one refresh and both received its committed token;
- two 401s for the same generation caused one refresh;
- two account grants at one endpoint remained separate;
- resource/issuer/scope mismatch made no refresh request;
- a caller abandoning its wait did not discard the rotated token;
- loss after rotation and failure to persist the response both prevented a second use of the old token;
- a network failure retained its cause and started no browser flow;
- forgetting during refresh left the record deleted after both finished;
- corrupt storage was rejected without replacement;
- the no-lock control could not satisfy both concurrent callers.

Removing serialization failed both concurrency checks. Removing the durable refresh marker failed both lost-result tests,
which then retried the consumed token and received `invalid_grant`. The experiment injected interruption between response
and persistence; it did not kill a real process or test Kage's secure-storage adapter. The temporary code is not product
implementation or a new permanent live suite.

Permanent regressions now live in `test/mcp-auth.test.ts`, `test/mcp-agent.test.ts`, `test/mcp-client.test.ts` and
`test/cli-mcp.integration.test.ts`. They cover shared/aliased storage, callback refusal/cancellation, deletion and persistence races,
different accounts, close isolation and unsafe replay. A real child process is killed after the fixture rotates a token
but before its response arrives; recovery refuses the fenced token. That test ages the orphaned lock deterministically
rather than waiting out the stale-lock window. Removing the fence makes it retry the consumed token and fail.

The built CLI and public `openAgent` passed Linear read-only acceptance on 2026-11-02: browser sign-in, two instances
sharing a grant, a call after closing the other instance, automatic refresh after forcing local expiry, and grant/session
reuse in a new process. No model provider was called and business output was not printed. This is not natural-expiry,
real-provider multi-account or downstream UI/secure-store acceptance. Release acceptance belongs to FastAgent's CLI,
embedding, HTTP and deployment scenarios; Kage integration is not a prerequisite.

The flow was repeated through the installed tarball after DNS/IP hardening, on Linux x64 / Node 24.15.0 with validated
public addresses. Direct and CONNECT-proxy calls, shared-grant close isolation, forced-expiry refresh and reuse after
container replacement passed. The proxy observed the pinned numeric IP; the host's fake-IP DNS path was independently
refused. Grants stayed on the state volume, not in the pre-authorization image. Temporary grants and business-bearing
sessions were removed without remote revocation.

MCP shipped in [0.29.0](https://github.com/fastagent-sh/fastagent/releases/tag/v0.29.0). Provider-session resources can
still outlive agent close ([#896](https://github.com/fastagent-sh/fastagent/issues/896), upstream
[pi#11676](https://github.com/earendil-works/pi/issues/11676)); this was explicitly accepted as a known release limitation,
not a claim that the resource cleanup bug was fixed.
