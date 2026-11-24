/**
 * An agent on Amazon Bedrock AgentCore, from wherever the AWS SDK runs: the Agent API, as `connectAgent` gives it,
 * each request one `InvokeAgentRuntime` on the session (signed with the SDK's credentials), wrapped as the runtime
 * unwraps it (`contract.ts`). AgentCore's refusals of an invocation it did not deliver come back as the Agent API's.
 *
 * Also implements FastAgent's pluggable `RemoteTransportModule` (`connectRemote`) so `remotes.json` entries with
 * `type: "agentcore"` work automatically across FastAgent CLI and `@fastagent-sh/pi-remote` without hardcoding
 * AgentCore inside `@fastagent-sh/client`, `@fastagent-sh/fastagent`, or `@fastagent-sh/pi-remote`.
 *
 * Zero server, database, CDK, or Node-only dependencies; installs `@aws-sdk/client-bedrock-agentcore` and `@fastagent-sh/client` directly.
 */
import {
  BedrockAgentCoreClient,
  BedrockAgentCoreServiceException,
  InvokeAgentRuntimeCommand,
  type InvokeAgentRuntimeCommandOutput,
} from "@aws-sdk/client-bedrock-agentcore";
import { type AuthApi, type ErrorCode, type RemoteAgent, agentError, errorData } from "@fastagent-sh/client/agent-api";
import { connectAgent, connectAuth } from "@fastagent-sh/client";
import { statusOf } from "@fastagent-sh/client/http/contract";
import type { ExtensionRemoteConfig, RemoteConnection, RemoteConnectOptions } from "@fastagent-sh/client/remotes";
import {
  type EnvelopedResponse,
  SESSION_ID_PATTERN,
  envelopeRequest,
  isEventStream,
  unwrapResponse,
} from "./contract.ts";

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
  ConversationId,
  CreateSessionOptions,
  EntriesOptions,
  Entry,
  ErrorCode,
  IdempotencyKey,
  InvokeApi,
  InvokeRequest,
  Json,
  ListOptions,
  Message,
  MessageId,
  MessageKey,
  MessageStatus,
  MessageStreamEvent,
  Metadata,
  ModelRef,
  Page,
  QueuedMessage,
  RemoteAgent,
  SendRequest,
  Session,
  SessionChanges,
  SessionEvent,
  SessionId,
  SessionSettings,
  SessionStatus,
  StartAuthLoginRequest,
  ThinkingLevel,
  Tokens,
  Usage,
  WaitOptions,
} from "@fastagent-sh/client/agent-api";
/** @public */
export { AgentError, LIMITS, hasEnded } from "@fastagent-sh/client/agent-api";
/** @public */
export { type ConnectOptions, connectAgent, connectAuth } from "@fastagent-sh/client";

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

const PLATFORM_REFUSALS: Record<string, ErrorCode> = {
  AccessDeniedException: "unauthorized",
  UnauthorizedException: "unauthorized",
  ExpiredTokenException: "unauthorized",
  UnrecognizedClientException: "unauthorized",
  InvalidSignatureException: "unauthorized",
  ThrottlingException: "unavailable",
  ServiceQuotaExceededException: "unavailable",
  RetryableConflictException: "unavailable",
  ResourceNotFoundException: "internal",
  ValidationException: "internal",
};

const clients = new Map<string, BedrockAgentCoreClient>();
const clientIn = (region: string): BedrockAgentCoreClient => {
  let client = clients.get(region);
  if (client === undefined) {
    client = new BedrockAgentCoreClient({ region });
    clients.set(region, client);
  }
  return client;
};

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
export function connectAgentCore(connection: AgentCoreConnection): RemoteAgent {
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

/**
 * Pluggable `remotes.json` transport entry for `type: "agentcore"`, invoked lazily by FastAgent CLI and
 * `@fastagent-sh/pi-remote`.
 * @public
 */
export function connectRemote(
  name: string,
  config: ExtensionRemoteConfig,
  options?: RemoteConnectOptions,
): RemoteConnection {
  if (options?.key !== undefined) {
    throw new Error(`--key cannot be used with AgentCore remote "${name}"`);
  }
  const runtimeArn = typeof config.runtimeArn === "string" ? config.runtimeArn.trim() : "";
  if (!runtimeArn) {
    throw new Error(`Remote "${name}" requires a non-empty "runtimeArn"`);
  }
  const sessionId = typeof config.sessionId === "string" ? config.sessionId.trim() : "";
  if (!sessionId) {
    throw new Error(`Remote "${name}" requires a non-empty "sessionId" for AgentCore`);
  }
  if (config.qualifier !== undefined && typeof config.qualifier !== "string") {
    throw new Error(`Remote "${name}" field "qualifier" must be a string`);
  }
  const connection: AgentCoreConnection = {
    runtimeArn,
    sessionId,
    ...(config.qualifier !== undefined ? { qualifier: config.qualifier } : {}),
  };
  return {
    agent: connectAgentCore(connection),
    auth: connectAgentCoreAuth(connection),
    label: `${name} (${runtimeArn})`,
  };
}
