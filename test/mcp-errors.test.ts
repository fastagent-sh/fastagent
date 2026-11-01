import { expect, it } from "vitest";
import { OAuthError, SdkError, SdkErrorCode, SdkHttpError } from "@modelcontextprotocol/client";
import { mcpFailure } from "../src/mcp/auth.ts";

const secret = "DO_NOT_PRINT_ACCESS_TOKEN_OR_CLIENT_SECRET";
it.each([
  "ENOENT",
  "EACCES",
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "UND_ERR_CONNECT_TIMEOUT",
])("keeps the allowlisted %s reason through nested causes without leaking error data", (code) => {
  const cause = Object.assign(new Error(secret), { code, path: secret, spawnargs: [secret], stderr: secret });
  const wrapped = new TypeError(secret, { cause: new AggregateError([cause], secret) });
  const failure = mcpFailure(wrapped, "MCP open", "local");
  expect(failure).toMatchObject({ code: "connection", server: "local" });
  expect(failure.message).toContain(code);
  expect(failure.message).not.toContain(secret);
  expect(failure.cause).toBeUndefined();
  expect(JSON.stringify(failure)).not.toContain(secret);
});
it("does not echo unknown error codes, names, OAuth response values or messages", () => {
  const ordinary = Object.assign(new Error(secret), { code: secret, name: secret });
  const oauth = OAuthError.fromResponse({
    error: secret,
    error_description: secret,
    error_uri: `https://example.test/${secret}`,
  });
  const sdk = new SdkError(SdkErrorCode.EraNegotiationFailed, secret, { response: secret });
  const closed = new SdkError(
    SdkErrorCode.EraNegotiationFailed,
    "Version negotiation failed: the connection closed during the server/discover probe before the server offered pinned protocol version " +
      secret,
  );
  for (const error of [ordinary, oauth, sdk, closed]) {
    const failure = mcpFailure(error, "MCP open");
    expect(`${failure.message} ${JSON.stringify(failure)}`).not.toContain(secret);
    expect(failure.cause).toBeUndefined();
  }
  expect(mcpFailure(sdk, "MCP open").message).toContain("ERA_NEGOTIATION_FAILED");
  expect(mcpFailure(closed, "MCP open").message).toContain("CONNECTION_CLOSED");
});
it("keeps HTTP status without disclosing the response text", () => {
  const error = new SdkHttpError(SdkErrorCode.ClientHttpFailedToOpenStream, secret, {
    status: 502,
    statusText: secret,
  });
  const failure = mcpFailure(error, "MCP open");
  expect(failure.message).toContain("HTTP 502");
  expect(failure.message).not.toContain(secret);
  expect(failure.cause).toBeUndefined();
});
it("terminates a cyclic cause chain and retains its safe reason", () => {
  const error = Object.assign(new Error(secret), { code: "ECONNRESET" });
  error.cause = error;
  expect(mcpFailure(error, "MCP call").message).toContain("ECONNRESET");
});
