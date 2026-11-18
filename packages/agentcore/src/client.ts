/**
 * An agent on AgentCore, from wherever the AWS SDK runs: the Agent API, as `connectAgent` gives it, each request one
 * `InvokeAgentRuntime` on the session (signed with the SDK's credentials), wrapped as the runtime unwraps it
 * (`envelope.ts`). AgentCore's refusals of an invocation it did not deliver come back as the Agent API's.
 */
import {
  BedrockAgentCoreClient,
  BedrockAgentCoreServiceException,
  InvokeAgentRuntimeCommand,
  type InvokeAgentRuntimeCommandOutput,
} from "@aws-sdk/client-bedrock-agentcore";
import { type Agent, connectAgent } from "@fastagent-sh/client";
import { type ErrorCode, agentError, errorData } from "@fastagent-sh/client/agent-api";
import { statusOf } from "@fastagent-sh/client/http/contract";
import { type EnvelopedResponse, envelopeRequest, isEventStream, unwrapResponse } from "./envelope.ts";

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
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{32,255}$/;

/**
 * AgentCore's refusals of an invocation it did not deliver, as the Agent API's: no runtime of that ARN, or a request it
 * does not take, is not one to send again. Any other (`RuntimeClientError`, its own failure) may have reached the agent,
 * and fails the request as one that got no answer.
 */
const PLATFORM_REFUSALS: Record<string, ErrorCode> = {
  AccessDeniedException: "unauthorized",
  UnauthorizedException: "unauthorized",
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

/** The Agent of the session `sessionId` on the runtime `runtimeArn`. */
export function connectAgentCore({ runtimeArn, sessionId, qualifier }: AgentCoreConnection): Agent {
  const region = RUNTIME_ARN.exec(runtimeArn)?.[1];
  if (region === undefined) {
    throw new Error(
      `${runtimeArn} is not an AgentCore runtime's ARN (arn:aws:bedrock-agentcore:<region>:…:runtime/<id>)`,
    );
  }
  if (!SESSION_ID.test(sessionId)) {
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
        "the runtime answered what is not an Agent API answer: does it serve `fastagent agentcore serve`?",
      );
    return unwrapResponse(answer.response);
  };
  return connectAgent(`https://${sessionId}.agentcore`, { fetch: agentCoreFetch });
}
