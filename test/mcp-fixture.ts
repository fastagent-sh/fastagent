/** A real MCP protocol handler with a controlled OAuth issuer and rotating refresh tokens; no external network. */
import { createHash } from "node:crypto";
import { McpServer, createMcpHandler, fromJsonSchema } from "@modelcontextprotocol/server";
import type { McpGrantRecord } from "../src/mcp-api.ts";

export function mcpFixture(origin?: string) {
  const issuer = origin ?? "https://auth.mcp.test";
  const url = origin ? `${origin}/mcp` : "https://mcp.test/mcp";
  const tokens = new Map<string, string>();
  const consumed = new Set<string>();
  const calls: string[] = [];
  let refreshes = 0;
  let exchanges = 0;
  let approvals = 0;
  let redirect = "";
  let challenge = "";
  let expectedState = "";
  let account = "one";
  let revision = 0;
  let networkFailure = false;
  let refreshDelay = 0;
  let expandedScope = false;
  let offersTools = true;
  const metadata = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    scopes_supported: ["read", "write"],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
  };
  const handler = createMcpHandler(
    (context) => {
      const server = new McpServer({ name: "fixture", version: "1" });
      if (!offersTools) return server;
      server.registerTool(
        "echo",
        {
          inputSchema: fromJsonSchema<{ text: string }>({
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
            additionalProperties: false,
          }),
        },
        async ({ text }) => ({ content: [{ type: "text", text }] }),
      );
      server.registerTool("bad", { inputSchema: fromJsonSchema({ type: "object", properties: {} }) }, async () => ({
        content: [{ type: "text", text: "fixture refused" }],
        isError: true,
      }));
      server.registerTool(
        "structured",
        { inputSchema: fromJsonSchema({ type: "object", properties: {} }) },
        async () => ({
          content: [],
          structuredContent: { value: 42 },
        }),
      );
      server.registerTool(
        "resource",
        { inputSchema: fromJsonSchema({ type: "object", properties: {} }) },
        async () => ({
          content: [{ type: "resource_link", uri: "https://mcp.test/result", name: "result" }],
        }),
      );
      server.registerTool(
        "identity",
        { inputSchema: fromJsonSchema({ type: "object", properties: {} }) },
        async () => ({
          content: [
            {
              type: "text",
              text:
                tokens.get(context.requestInfo?.headers.get("authorization")?.replace(/^Bearer /, "") ?? "") ??
                "anonymous",
            },
          ],
        }),
      );
      return server;
    },
    { legacy: "reject" },
  );
  const issue = (who: string) => {
    revision++;
    const access = `access-${who}-${revision}`,
      refresh = `refresh-${who}-${revision}`;
    tokens.set(access, who);
    tokens.set(refresh, who);
    return {
      access_token: access,
      refresh_token: refresh,
      expires_in: 3600,
      token_type: "Bearer",
      scope: expandedScope ? "read write" : "read",
    };
  };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    const target = new URL(request.url);
    calls.push(`${request.method} ${target.origin}${target.pathname}`);
    if (target.pathname.includes("oauth-protected-resource"))
      return Response.json({ resource: url, authorization_servers: [issuer], scopes_supported: ["read"] });
    if (target.origin === issuer && target.pathname.includes("well-known")) return Response.json(metadata);
    if (target.href === `${issuer}/register`)
      return Response.json(
        { ...((await request.json()) as Record<string, unknown>), client_id: "fixture-client" },
        { status: 201 },
      );
    if (target.href === `${issuer}/token`) {
      const body = new URLSearchParams(await request.text());
      if (body.get("resource") !== url) return Response.json({ error: "invalid_target" }, { status: 400 });
      if (body.get("grant_type") === "refresh_token") {
        refreshes++;
        if (networkFailure) throw new Error("network unavailable");
        const token = body.get("refresh_token") ?? "";
        if (!tokens.has(token) || consumed.has(token))
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        consumed.add(token);
        await new Promise((resolve) => setTimeout(resolve, refreshDelay));
        return Response.json(issue(tokens.get(token) as string));
      }
      exchanges++;
      if (
        body.get("code") !== "approved-code" ||
        body.get("redirect_uri") !== redirect ||
        createHash("sha256")
          .update(body.get("code_verifier") ?? "")
          .digest("base64url") !== challenge
      )
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json(issue(account));
    }
    if (target.href === url) {
      const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
      if (!token || !tokens.has(token))
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="${url}/.well-known/oauth-protected-resource", scope="read"`,
          },
        });
      return handler.fetch(request);
    }
    return new Response("not found", { status: 404 });
  };
  return {
    issuer,
    url,
    fetch,
    calls,
    get refreshes() {
      return refreshes;
    },
    get exchanges() {
      return exchanges;
    },
    get approvals() {
      return approvals;
    },
    set networkFailure(value: boolean) {
      networkFailure = value;
    },
    set refreshDelay(value: number) {
      refreshDelay = value;
    },
    set expandedScope(value: boolean) {
      expandedScope = value;
    },
    set offersTools(value: boolean) {
      offersTools = value;
    },
    invalidate(token: string) {
      tokens.delete(token);
    },
    grant(who = "one", expired = true): McpGrantRecord {
      const pair = issue(who);
      return {
        version: 1,
        serverUrl: url,
        resource: url,
        issuer,
        client: { id: "fixture-client", tokenEndpointAuthMethod: "none" },
        scopes: ["read"],
        status: "ready",
        generation: 0,
        accessToken: pair.access_token,
        refreshToken: pair.refresh_token,
        expiresAt: Date.now() + (expired ? -1000 : 3600_000),
      };
    },
    async approve(
      authUrl: string,
      opts: { deny?: boolean; wrongIssuer?: boolean; wrongState?: boolean; account?: string } = {},
    ) {
      approvals++;
      const auth = new URL(authUrl);
      redirect = auth.searchParams.get("redirect_uri") as string;
      challenge = auth.searchParams.get("code_challenge") as string;
      expectedState = auth.searchParams.get("state") as string;
      account = opts.account ?? "one";
      const back = new URL(redirect);
      back.searchParams.set("state", opts.wrongState ? "wrong" : expectedState);
      back.searchParams.set("iss", opts.wrongIssuer ? "https://other.test" : issuer);
      back.searchParams.set(opts.deny ? "error" : "code", opts.deny ? "access_denied" : "approved-code");
      return globalThis.fetch(back);
    },
  };
}
