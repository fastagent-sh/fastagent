/** Explicit browser OAuth for MCP; no auth URL, code or token passes through a model turn. */
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { resolve } from "node:path";
import { agentValues } from "../value-file.ts";
import { loadMcp, mcpInstanceOf, resolveMcpServers } from "./config.ts";
import {
  registerClient,
  startAuthorization,
  exchangeAuthorization,
  selectClientAuthMethod,
  validateAuthorizationResponseIssuer,
  type OAuthClientInformationMixed,
  type OAuthTokens,
} from "@modelcontextprotocol/client";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import { fromPromise, joinPromise, cleanupQuietly, originalError } from "../promise-bridge.ts";
import { McpError, type McpGrantRecord, type McpGrantSummary, type McpSignInRequest } from "../mcp-api.ts";
import { discoverMcp, mcpFailure } from "./auth.ts";
import { mcpFetch, openMcpNetwork } from "./network.ts";
import { httpServer } from "./host.ts";
import { grantSummary } from "./grants.ts";

const escapeHtml = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

function callbackUrlOf(request: IncomingMessage, response: ServerResponse): URL | undefined {
  const url = URL.parse(request.url ?? "/", "http://127.0.0.1");
  if (url === null) {
    response.writeHead(400).end("invalid request URL\n");
    return undefined;
  }
  return url;
}

function sendCallbackStatus(response: ServerResponse, status: number, heading: string, detail: string): void {
  response.statusCode = status;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader(
    "content-security-policy",
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
  );
  response.end(
    `<!doctype html><meta charset="utf-8"><title>MCP authorization — FastAgent</title>` +
      `<body style="font:16px/1.5 system-ui,sans-serif;max-width:480px;margin:48px auto;padding:0 16px">` +
      `<h1>${escapeHtml(heading)}</h1><p>${escapeHtml(detail)}</p>` +
      `<p>Return to your terminal. Do not copy this address.</p></body>`,
  );
}

export async function signInMcp(request: McpSignInRequest): Promise<McpGrantSummary> {
  const timeout = request.timeoutSeconds ?? 900;
  if (
    !Number.isInteger(timeout) ||
    timeout <= 0 ||
    (request.callbackPort !== undefined &&
      (!Number.isInteger(request.callbackPort) || request.callbackPort < 0 || request.callbackPort > 65535))
  ) {
    throw new McpError("configuration", "Invalid MCP sign-in timeout or callback port", request.server);
  }
  const dir = resolve(request.agentDir);
  const declarations = await loadMcp(dir, mcpInstanceOf(request));
  const server = httpServer(
    resolveMcpServers(
      declarations,
      { ...process.env, ...agentValues(dir), ...request.variables },
      request.server,
      dir,
      {},
    ),
    request.server,
  );
  let saved: McpGrantSummary | undefined;
  const work = Effect.gen(function* () {
    const network = yield* Effect.acquireRelease(
      fromPromise(() => openMcpNetwork(server.url, request.fetch)),
      (value) => cleanupQuietly("MCP network", () => value.close()),
    );
    const fetchImpl = mcpFetch(server.url, network.fetch);
    const discovery = yield* fromPromise(() => discoverMcp(server.url, fetchImpl));
    if (!discovery.metadata.code_challenge_methods_supported?.includes("S256")) {
      return yield* Effect.fail(
        new McpError("protocol", "MCP authorization server does not advertise PKCE S256", server.name),
      );
    }
    if (!request.clientId && !discovery.metadata.registration_endpoint)
      return yield* Effect.fail(
        new McpError(
          "configuration",
          "This MCP service requires a public clientId or client metadata URL; dynamic registration is unavailable",
          server.name,
        ),
      );
    const scopes = [...new Set(request.scopes ?? discovery.resourceMetadata.scopes_supported ?? [])];
    if (scopes.some((scope) => !/^[\x21\x23-\x5B\x5D-\x7E]+$/.test(scope)))
      return yield* Effect.fail(new McpError("configuration", "Invalid OAuth scope", server.name));
    const approved = yield* fromPromise(() =>
      request.interaction.confirmAuthorization({
        server: server.name,
        resource: discovery.resource,
        issuer: discovery.issuer,
        scopes,
      }),
    );
    if (!approved) return yield* Effect.fail(new McpError("canceled", "MCP authorization canceled", server.name));
    const callback = yield* Deferred.make<URLSearchParams, McpError>();
    const state = randomBytes(32).toString("base64url");
    const path = request.clientId ? "/mcp/oauth/callback" : `/mcp/oauth/${randomBytes(24).toString("hex")}`;
    let portNumber = 0;
    let consumed = false;
    const listener = createServer((incoming, response) => {
      // This one-shot listener closes after sign-in; a later flow may bind the same callback port.
      response.setHeader("connection", "close");
      const url = callbackUrlOf(incoming, response);
      if (!url) return;
      if (
        incoming.headers.host !== `127.0.0.1:${portNumber}` ||
        incoming.method !== "GET" ||
        url.pathname !== path ||
        consumed
      ) {
        response.writeHead(404).end("not found\n");
        return;
      }
      const received = url.searchParams.get("state") ?? "";
      if (
        Buffer.byteLength(received) !== Buffer.byteLength(state) ||
        !timingSafeEqual(Buffer.from(received), Buffer.from(state))
      ) {
        response.writeHead(400).end("invalid OAuth state\n");
        return;
      }
      let problem: McpError | undefined;
      try {
        validateAuthorizationResponseIssuer({
          iss: url.searchParams.get("iss") ?? undefined,
          expectedIssuer: discovery.issuer,
          issParameterSupported: discovery.metadata.authorization_response_iss_parameter_supported === true,
        });
        if (url.searchParams.has("error"))
          problem = new McpError("canceled", "MCP authorization was not approved", server.name);
        else if (!url.searchParams.get("code"))
          problem = new McpError("protocol", "MCP callback contained no authorization code", server.name);
      } catch {
        problem = new McpError("authorization_mismatch", "MCP OAuth callback issuer mismatch", server.name);
      }
      consumed = true;
      const completed = problem ? Deferred.fail(callback, problem) : Deferred.succeed(callback, url.searchParams);
      // Closing the scope tears down the listener; first flush the page or observe the browser disconnect.
      if (response.destroyed) Effect.runSync(completed);
      else response.once("close", () => Effect.runSync(completed));
      sendCallbackStatus(
        response,
        problem ? 400 : 200,
        problem ? "Authorization stopped" : "Authorization response received",
        problem?.message ?? "FastAgent is verifying and saving the authorization.",
      );
    });
    yield* Effect.acquireRelease(Effect.succeed(listener), (value) =>
      cleanupQuietly(
        "MCP OAuth callback",
        () =>
          new Promise<void>((resolve, reject) => {
            value.close((error) => (error ? reject(error) : resolve()));
            value.closeAllConnections();
          }),
      ),
    );
    yield* joinPromise(
      () =>
        new Promise<void>((resolve, reject) => {
          listener.once("error", reject);
          listener.listen(request.callbackPort ?? 0, "127.0.0.1", () => {
            listener.off("error", reject);
            resolve();
          });
        }),
    );
    const address = listener.address();
    if (!address || typeof address === "string")
      return yield* Effect.fail(new McpError("connection", "MCP callback has no local port", server.name));
    portNumber = address.port;
    const redirectUrl = `http://127.0.0.1:${portNumber}${path}`;
    const registration: OAuthClientInformationMixed = request.clientId
      ? { client_id: request.clientId }
      : yield* joinPromise(() =>
          registerClient(discovery.issuer, {
            metadata: discovery.metadata,
            clientMetadata: {
              client_name: "FastAgent",
              redirect_uris: [redirectUrl],
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
              token_endpoint_auth_method: "none",
              application_type: "native",
              scope: scopes.join(" "),
            },
            scope: scopes.join(" "),
            fetchFn: fetchImpl,
          }),
        );
    const { authorizationUrl, codeVerifier } = yield* joinPromise(() =>
      startAuthorization(discovery.issuer, {
        metadata: discovery.metadata,
        clientInformation: registration,
        state,
        redirectUrl,
        scope: scopes.join(" "),
        resource: discovery.resource,
      }),
    );
    request.interaction.notify({ type: "auth_url", url: authorizationUrl.href });
    const params = yield* Deferred.await(callback);
    // Redeeming a code can consume it. Finish the bounded exchange and durable save even if its waiter cancels.
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        request.interaction.notify({ type: "progress", message: "Saving MCP authorization" });
        const tokens: OAuthTokens = yield* joinPromise(() =>
          exchangeAuthorization(discovery.issuer, {
            metadata: discovery.metadata,
            clientInformation: registration,
            authorizationCode: params.get("code") as string,
            codeVerifier,
            redirectUri: redirectUrl,
            iss: params.get("iss") ?? undefined,
            resource: discovery.resource,
            fetchFn: fetchImpl,
          }),
        );
        const granted = tokens.scope === undefined ? scopes : tokens.scope.split(/\s+/).filter(Boolean);
        if (tokens.token_type.toLowerCase() !== "bearer" || granted.some((scope) => !scopes.includes(scope)))
          return yield* Effect.fail(
            new McpError(
              "insufficient_scope",
              "MCP authorization returned an unsupported token type or unapproved scopes",
              server.name,
            ),
          );
        const method = selectClientAuthMethod(
          registration,
          discovery.metadata.token_endpoint_auth_methods_supported ?? [],
        );
        if (method !== "none" && method !== "client_secret_post" && method !== "client_secret_basic")
          return yield* Effect.fail(
            new McpError("protocol", "Unsupported MCP client authentication method", server.name),
          );
        const record: McpGrantRecord = {
          version: 1,
          serverUrl: server.url,
          resource: discovery.resource,
          issuer: discovery.issuer,
          client: {
            id: registration.client_id,
            tokenEndpointAuthMethod: method,
            ...("client_secret" in registration && registration.client_secret
              ? { secret: registration.client_secret }
              : {}),
          },
          scopes: granted,
          status: "ready",
          generation: 0,
          accessToken: tokens.access_token,
          ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
          ...(tokens.expires_in === undefined ? {} : { expiresAt: Date.now() + tokens.expires_in * 1000 }),
        };
        const id = randomUUID();
        yield* joinPromise(() =>
          request.store.withGrant(id, async (access) => {
            if (access.read()) throw new McpError("storage", "MCP grant ID collision");
            await access.write(record);
          }),
        );
        saved = grantSummary(id, record);
        return saved;
      }),
    );
  }).pipe(Effect.timeout(timeout * 1000), Effect.scoped);
  const result = await Effect.runPromiseExit(work, { signal: request.interaction.signal });
  if (saved) return saved;
  if (Exit.isFailure(result)) {
    if (Exit.hasInterrupts(result) || request.interaction.signal?.aborted)
      throw new McpError("canceled", "MCP sign-in canceled", request.server);
    throw mcpFailure(originalError(result.cause), "MCP sign-in", request.server);
  }
  return result.value;
}
