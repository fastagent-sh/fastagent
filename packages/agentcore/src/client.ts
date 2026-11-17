/**
 * An agent on AgentCore, from wherever the AWS SDK runs: the Agent API, as `connectAgent` gives it, through the session's
 * endpoint. AgentCore invokes a runtime only at one path and turns any refusal into its own 424, so the Agent API goes
 * through the endpoint it gives each session, which passes every route, status, header and stream as they are.
 *
 * An invocation is what hands out that endpoint, so the first request binds with one (`{}`). A request through it is
 * signed (SigV4, the SDK's credentials) and names the session, since a microVM AgentCore starts again behind the same
 * endpoint is told nothing else. AgentCore's own refusals of a request it did not deliver come back as the Agent API's.
 */
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore";
import { SignatureV4 } from "@smithy/signature-v4";
import { type Agent, connectAgent } from "@fastagent-sh/client";
import { type ErrorCode, agentError, errorData } from "@fastagent-sh/client/agent-api";
import { statusOf } from "@fastagent-sh/client/http/contract";

export interface AgentCoreConnection {
  /** The runtime: `arn:aws:bedrock-agentcore:<region>:<account>:runtime/<id>`. */
  runtimeArn: string;
  /**
   * The session, and so the instance: one per user or chat, kept by the caller. AgentCore's rule: 33 to 256 letters,
   * digits, `-` and `_`, starting with a letter or digit.
   */
  sessionId: string;
}

const SESSION_HEADER = "x-amzn-bedrock-agentcore-runtime-session-id";
const PLATFORM_ERROR = "x-amzn-bedrock-agentcore-runtime-error";
const RUNTIME_ARN = /^arn:aws[a-z-]*:bedrock-agentcore:([a-z0-9-]+):\d{12}:runtime\/[A-Za-z0-9_-]+$/;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{32,255}$/;
/** How often a request meets a session AgentCore is still starting or stopping before it gives up. */
const CONFLICT_TRIES = 5;

/** AgentCore's refusals of a request it did not deliver to the container, as the Agent API's. */
const PLATFORM_REFUSALS: Record<string, ErrorCode> = {
  AuthenticationRequired: "unauthorized",
  AccessDenied: "unauthorized",
  Throttled: "unavailable",
  SessionConflict: "unavailable",
  SessionNotFound: "unavailable",
  MalformedRequest: "internal",
  ProtocolError: "internal",
};

/** The Agent of the session `sessionId` on the runtime `runtimeArn`. */
export function connectAgentCore({ runtimeArn, sessionId }: AgentCoreConnection): Agent {
  const region = RUNTIME_ARN.exec(runtimeArn)?.[1];
  if (region === undefined) {
    throw new Error(
      `${runtimeArn} is not an AgentCore runtime's ARN (arn:aws:bedrock-agentcore:<region>:…:runtime/<id>)`,
    );
  }
  if (!SESSION_ID.test(sessionId)) {
    throw new Error(`the session id "${sessionId}" must be 33 to 256 letters, digits, "-" and "_" (AgentCore's rule)`);
  }
  const aws = new BedrockAgentCoreClient({ region });
  const signer = new SignatureV4({
    service: "bedrock-agentcore",
    region,
    credentials: aws.config.credentials,
    sha256: aws.config.sha256,
  });

  let endpoint: Promise<string> | undefined;
  const bind = async (): Promise<string> => {
    const invoked = await aws.send(
      new InvokeAgentRuntimeCommand({
        agentRuntimeArn: runtimeArn,
        runtimeSessionId: sessionId,
        contentType: "application/json",
        accept: "application/json",
        payload: new TextEncoder().encode("{}"),
      }),
    );
    await invoked.response?.transformToString();
    if (!invoked.sessionEndpointUrl) {
      throw new Error(
        `the runtime ${runtimeArn} gives no session endpoint: create it with allowedPorts [{ port: 8080 }]`,
      );
    }
    return invoked.sessionEndpointUrl;
  };
  const sessionEndpoint = () =>
    (endpoint ??= bind().catch((error: unknown) => {
      endpoint = undefined;
      throw error;
    }));

  const send = async (request: Request, body: ArrayBuffer | undefined, base: string): Promise<Response> => {
    const asked = new URL(request.url);
    const url = new URL(asked.pathname + asked.search, base);
    const headers: Record<string, string> = { host: url.host, [SESSION_HEADER]: sessionId };
    for (const [name, value] of request.headers) {
      if (name !== "authorization" && name !== "host" && name !== "content-length") headers[name] = value;
    }
    if (body !== undefined) headers["content-length"] = String(body.byteLength);
    const query: Record<string, string[]> = {};
    for (const [name, value] of url.searchParams) query[name] = [...(query[name] ?? []), value];
    // Without x-amz-content-sha256 the endpoint takes a signature over no body, and the body is sent beside it.
    const signed = await signer.sign({
      method: request.method,
      protocol: url.protocol,
      hostname: url.hostname,
      path: url.pathname,
      query,
      headers,
    });
    return fetch(url, { method: request.method, headers: signed.headers, body, signal: request.signal });
  };

  const agentCoreFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = request.body === null ? undefined : await request.arrayBuffer();
    for (let attempt = 1; ; attempt++) {
      const response = await send(request, body, await sessionEndpoint());
      const platform = response.headers.get(PLATFORM_ERROR);
      if (platform === null) return response;
      // The session ended (its lifetime is 8 hours at most): an invocation starts it again, with its endpoint.
      if (platform === "SessionNotFound" && attempt === 1) {
        endpoint = undefined;
        continue;
      }
      if (platform === "SessionConflict" && attempt < CONFLICT_TRIES) {
        await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
        continue;
      }
      const code = PLATFORM_REFUSALS[platform];
      // Any other (a timeout, AgentCore's own failure) may have reached the agent: left as it came, for the Caller to say.
      if (code === undefined) return response;
      await response.body?.cancel();
      const error = errorData(agentError(code, `AgentCore refused the request: ${platform} (HTTP ${response.status})`));
      return Response.json({ error }, { status: statusOf(error) });
    }
  };
  return connectAgent(`https://bedrock-agentcore.${region}.amazonaws.com`, { fetch: agentCoreFetch });
}
