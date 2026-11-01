/** OAuth discovery and refresh policy. Background calls never start an interactive sign-in. */
import {
  checkResourceAllowed,
  discoverOAuthProtectedResourceMetadata,
  discoverAuthorizationServerMetadata,
  extractWWWAuthenticateParams,
  refreshAuthorization,
  type AuthorizationServerMetadata,
  OAuthError,
  SdkError,
  SdkHttpError,
  UnauthorizedError,
  InsufficientScopeError,
  IssuerMismatchError,
  type OAuthProtectedResourceMetadata,
} from "@modelcontextprotocol/client";
import { McpError, type McpGrantRecord, type McpGrantStore } from "../mcp-api.ts";
import { checkMcpTarget } from "./network.ts";
import { checkedGrant } from "./grants.ts";

export interface McpDiscovery {
  metadata: AuthorizationServerMetadata;
  resourceMetadata: OAuthProtectedResourceMetadata;
  issuer: string;
  resource: string;
}

export async function discoverMcp(url: string, fetchImpl: typeof globalThis.fetch): Promise<McpDiscovery> {
  const challenge = await fetchImpl(url, { headers: { Accept: "application/json, text/event-stream" } });
  await challenge.body?.cancel();
  if (!challenge.ok && ![401, 403, 404, 405].includes(challenge.status))
    throw new McpError("connection", `MCP resource probe failed (HTTP ${challenge.status})`);
  const { resourceMetadataUrl } = extractWWWAuthenticateParams(challenge);
  const hints = challenge.headers.get("www-authenticate")?.match(/\bresource_metadata\s*=/gi) ?? [];
  if (hints.length > 1 || (hints.length === 1 && !resourceMetadataUrl))
    throw new McpError("protocol", "Unusable MCP resource_metadata challenge; refusing default discovery");
  if (resourceMetadataUrl) checkMcpTarget(url, resourceMetadataUrl.href);
  const resource = await discoverOAuthProtectedResourceMetadata(url, { resourceMetadataUrl }, fetchImpl);
  const issuer = resource.authorization_servers?.[0] ?? new URL("/", url).href;
  checkMcpTarget(url, issuer);
  const metadata = await discoverAuthorizationServerMetadata(issuer, { fetchFn: fetchImpl });
  if (
    !metadata ||
    !resource ||
    !checkResourceAllowed({ requestedResource: new URL(url), configuredResource: resource.resource })
  ) {
    throw new McpError(
      "authorization_mismatch",
      "MCP authorization discovery did not identify the configured resource and issuer",
    );
  }
  checkMcpTarget(url, metadata.issuer);
  checkMcpTarget(url, metadata.authorization_endpoint);
  checkMcpTarget(url, metadata.token_endpoint);
  if (metadata.registration_endpoint) checkMcpTarget(url, metadata.registration_endpoint);
  return { metadata, resourceMetadata: resource, resource: resource.resource, issuer: metadata.issuer };
}

export function checkGrantTarget(record: McpGrantRecord, url: string, discovery?: McpDiscovery): void {
  if (
    record.serverUrl !== url ||
    (discovery && (record.issuer !== discovery.issuer || record.resource !== discovery.resource))
  ) {
    throw new McpError(
      "authorization_mismatch",
      "MCP grant belongs to a different endpoint, resource or issuer; sign in explicitly for this server",
    );
  }
}

export function mcpFailure(error: unknown, operation: string, server?: string): McpError {
  if (error instanceof McpError)
    return error.server || !server ? error : new McpError(error.code, error.message, server);
  if (error instanceof IssuerMismatchError)
    return new McpError("authorization_mismatch", `${operation}: OAuth issuer validation failed`, server);
  if (error instanceof UnauthorizedError || (error instanceof SdkHttpError && error.status === 401))
    return new McpError(
      "authorization_required",
      `${operation}: MCP authorization required; sign in for this server`,
      server,
    );
  if (error instanceof InsufficientScopeError || (error instanceof SdkHttpError && error.status === 403))
    return new McpError(
      "insufficient_scope",
      `${operation}: MCP access refused (HTTP 403); review the grant permissions`,
      server,
    );
  // SDK and HTTP errors may include token responses; expose classification, never their raw payload or cause.
  const code =
    error instanceof OAuthError || error instanceof SdkError
      ? error.code
      : error instanceof Error
        ? error.name
        : "unknown error";
  return new McpError("connection", `${operation} failed (${code})`, server);
}

export async function grantToken(input: {
  store: McpGrantStore;
  id: string;
  url: string;
  fetch: typeof globalThis.fetch;
  discovery?: McpDiscovery;
  rejectedGeneration?: number;
}): Promise<{ token: string; generation: number }> {
  return input.store.withGrant(input.id, async (access) => {
    const raw = access.read();
    if (!raw) throw new McpError("authorization_required", "No MCP grant is stored; sign in before opening this agent");
    const record = checkedGrant(raw);
    checkGrantTarget(record, input.url, input.discovery);
    if (record.status !== "ready")
      throw new McpError(
        record.status === "refreshing" ? "refresh_uncertain" : "authorization_required",
        "MCP authorization must be renewed; the previous grant cannot be refreshed safely",
      );
    const fresh = record.expiresAt === undefined || record.expiresAt > Date.now() + 30_000;
    if (fresh && (input.rejectedGeneration === undefined || record.generation !== input.rejectedGeneration)) {
      return { token: record.accessToken, generation: record.generation };
    }
    if (!record.refreshToken) {
      await access.write({ ...record, status: "reauthorization_required" });
      throw new McpError("authorization_required", "MCP authorization expired and has no refresh token; sign in again");
    }
    const discovery = await discoverMcp(input.url, input.fetch);
    checkGrantTarget(record, input.url, discovery);
    // Persist before the remote server can consume the old token. A lost response cannot be replayed safely.
    await access.write({ ...record, status: "refreshing" });
    let tokens: Awaited<ReturnType<typeof refreshAuthorization>>;
    try {
      tokens = await refreshAuthorization(record.issuer, {
        metadata: discovery.metadata,
        clientInformation: {
          client_id: record.client.id,
          ...(record.client.secret === undefined ? {} : { client_secret: record.client.secret }),
          token_endpoint_auth_method: record.client.tokenEndpointAuthMethod,
        },
        refreshToken: record.refreshToken,
        resource: record.resource,
        fetchFn: input.fetch,
      });
    } catch (error) {
      if (
        error instanceof OAuthError &&
        ["invalid_grant", "invalid_client", "unauthorized_client"].includes(error.code)
      ) {
        await access.write({ ...record, status: "reauthorization_required" });
        throw new McpError("authorization_required", "The MCP authorization server refused the refresh; sign in again");
      }
      throw mcpFailure(error, "MCP token refresh");
    }
    const scopes = tokens.scope === undefined ? record.scopes : tokens.scope.split(/\s+/).filter(Boolean);
    if (scopes.some((scope) => !record.scopes.includes(scope)))
      throw new McpError("insufficient_scope", "MCP refresh unexpectedly expanded the grant's scopes");
    const next: McpGrantRecord = {
      ...record,
      scopes,
      status: "ready",
      generation: record.generation + 1,
      accessToken: tokens.access_token,
      ...(tokens.refresh_token === undefined ? {} : { refreshToken: tokens.refresh_token }),
      expiresAt: tokens.expires_in === undefined ? undefined : Date.now() + tokens.expires_in * 1000,
    };
    if (tokens.token_type.toLowerCase() !== "bearer")
      throw new McpError("protocol", "Only bearer MCP grants are supported");
    await access.write(next);
    return { token: next.accessToken, generation: next.generation };
  });
}
