/**
 * An agent on Amazon Bedrock AgentCore, from wherever the AWS SDK runs: the Agent API, as `connectAgent` gives it,
 * each request one `InvokeAgentRuntime` on the session (signed with the SDK's credentials), wrapped as the runtime
 * unwraps it (`agentcore/contract.ts`). AgentCore's refusals of an invocation it did not deliver come back as the
 * Agent API's.
 *
 * Install `@aws-sdk/client-bedrock-agentcore` alongside `@fastagent-sh/client` when importing this subpath; the root
 * `@fastagent-sh/client` entry loads no AWS package.
 */
import {
  BedrockAgentCoreClient,
  BedrockAgentCoreServiceException,
  InvokeAgentRuntimeCommand,
  type InvokeAgentRuntimeCommandOutput,
} from "@aws-sdk/client-bedrock-agentcore";
import { type Agent, type AuthApi, type ErrorCode, agentError, errorData } from "./agent-api.ts";
import {
  type EnvelopedResponse,
  SESSION_ID_PATTERN,
  envelopeRequest,
  isEventStream,
  unwrapResponse,
} from "./agentcore/contract.ts";
import { connectAgent, connectAuth } from "./http/client.ts";
import { statusOf } from "./http/contract.ts";

/** @public */
export type {
  ActiveTool,
  Agent,
  AgentErrorData,
  AgentInfo,
  AuthApi,
  AuthFlowState,
  AuthFlowStatus,
  AuthLoginInput,
  AuthMethod,
  AuthPromptInfo,
  AuthProviderStatus,
  CompactOptions,
  ContentPart,
  ContextUsage,
  CreateSessionOptions,
  EntriesOptions,
  Entry,
  ErrorCode,
  Json,
  ListOptions,
  Message,
  MessageKey,
  MessageStatus,
  MessageStreamEvent,
  Metadata,
  ModelRef,
  Page,
  QueuedMessage,
  SendRequest,
  Session,
  SessionChanges,
  SessionEvent,
  SessionSettings,
  SessionStatus,
  StartAuthLoginRequest,
  ThinkingLevel,
  Tokens,
  Usage,
  WaitOptions,
} from "./agent-api.ts";
/** @public */
export { AgentError, LIMITS, hasEnded } from "./agent-api.ts";
/** @public */
export { type ConnectOptions, connectAgent, connectAuth } from "./http/client.ts";

/** @public */
export interface AgentCoreConnection {
  /** The runtime: `arn:aws:bedrock-agentcore:<region>:<account>:runtime/<id>`. */
  runtimeArn: string;
  /**
   * The session, and so the instance: one per user or chat, kept by the caller. AgentCore's rule: 33 to 256 letters,
   * digits, `-` and `_`, starting with a letter or digit.
   */
  sessionId: string;
  /** The runtime endpoint, which picks the version that answers: `prod`, a release's. Default: `DEFAULT`. */
  qualifier?: string;
}

const RUNTIME_ARN = /^arn:aws[a-z-]*:bedrock-agentcore:([a-z0-9-]+):\d{12}:runtime\/[A-Za-z0-9_-]+$/;

/**
 * AgentCore's refusals of an invocation it did not deliver, as the Agent API's: no runtime of that ARN, or a request it
 * does not take, is not one to send again. Any other (`RuntimeClientError`, its own failure) may have reached the agent,
 * and fails the request as one that got no answer.
 */
const PLATFORM_REFUSALS: Record<string, ErrorCode> = {
  AccessDeniedException: "unauthorized",
  UnauthorizedException: "unauthorized",
  // Credentials AWS took for none: expired, or not a key it knows. Refreshing them is the Caller's.
  ExpiredTokenException: "unauthorized",
  UnrecognizedClientException: "unauthorized",
  InvalidSignatureException: "unauthorized",
  ThrottlingException: "unavailable",
  ServiceQuotaExceededException: "unavailable",
  RetryableConflictException: "unavailable",
  ResourceNotFoundException: "internal",
  ValidationException: "internal",
};

/** One client a region, for every connection: a backend connects a session a user, and each would resolve credentials. */
const clients = new Map<string, BedrockAgentCoreClient>();
const clientIn = (region: string): BedrockAgentCoreClient => {
  let client = clients.get(region);
  if (client === undefined) {
    client = new BedrockAgentCoreClient({ region });
    clients.set(region, client);
  }
  return client;
};

/**
 * The Agent of the session `sessionId` on the runtime `runtimeArn`.
 * @public
 */
function agentCoreTransport({ runtimeArn, sessionId, qualifier }: AgentCoreConnection): {
  url: string;
  fetch: typeof fetch;
} {
  const region = RUNTIME_ARN.exec(runtimeArn)?.[1];
  if (region === undefined) {
    throw new Error(
      `${runtimeArn} is not an AgentCore runtime's ARN (arn:aws:bedrock-agentcore:<region>:…:runtime/<id>)`,
    );
  }
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`the session id "${sessionId}" must be 33 to 256 letters, digits, "-" and "_" (AgentCore's rule)`);
  }
  const aws = clientIn(region);

  const agentCoreFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const payload = JSON.stringify({ request: await envelopeRequest(request) });
    let invoked: InvokeAgentRuntimeCommandOutput;
    try {
      invoked = await aws.send(
        new InvokeAgentRuntimeCommand({
          agentRuntimeArn: runtimeArn,
          runtimeSessionId: sessionId,
          ...(qualifier === undefined ? {} : { qualifier }),
          contentType: "application/json",
          accept: "application/json, text/event-stream",
          payload: new TextEncoder().encode(payload),
        }),
        { abortSignal: request.signal },
      );
    } catch (error) {
      // No credentials to sign with, or a session to sign in again (`aws login`): no retry finds others.
      if ((error as Error).name === "CredentialsProviderError") {
        const refusal = errorData(
          agentError("unauthorized", `no AWS credentials to call AgentCore with: ${(error as Error).message}`),
        );
        return Response.json({ error: refusal }, { status: statusOf(refusal) });
      }
      if (!(error instanceof BedrockAgentCoreServiceException)) throw error;
      const code = PLATFORM_REFUSALS[error.name];
      if (code === undefined) throw error;
      const refusal = errorData(agentError(code, `AgentCore refused the request: ${error.name}: ${error.message}`));
      return Response.json({ error: refusal }, { status: statusOf(refusal) });
    }
    if (invoked.response === undefined) throw new Error("AgentCore answered the invocation with no body");
    if (isEventStream(invoked.contentType)) {
      return new Response(invoked.response.transformToWebStream(), {
        headers: { "content-type": invoked.contentType ?? "" },
      });
    }
    const answer = JSON.parse(await invoked.response.transformToString()) as { response?: EnvelopedResponse };
    if (answer.response === undefined)
      throw new Error(
        "the runtime answered what is not an Agent API answer: does it serve `fastagent agentcore start`?",
      );
    return unwrapResponse(answer.response);
  };
  return { url: `https://${sessionId}.agentcore`, fetch: agentCoreFetch };
}

/**
 * The Agent of the session `sessionId` on the runtime `runtimeArn`.
 * @public
 */
export function connectAgentCore(connection: AgentCoreConnection): Agent {
  const { url, fetch } = agentCoreTransport(connection);
  return connectAgent(url, { fetch });
}

/**
 * The Auth API (remote model-provider login and logout) of the session `sessionId` on the runtime `runtimeArn`.
 * @public
 */
export function connectAgentCoreAuth(connection: AgentCoreConnection): AuthApi {
  const { url, fetch } = agentCoreTransport(connection);
  return connectAuth(url, { fetch });
}
