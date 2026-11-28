/**
 * Shared Amazon Bedrock AgentCore Fetch transport used by both the Agent API (`index.ts`) and Auth API (`auth.ts`).
 */
import {
  BedrockAgentCoreClient,
  BedrockAgentCoreServiceException,
  InvokeAgentRuntimeCommand,
  type InvokeAgentRuntimeCommandOutput,
} from "@aws-sdk/client-bedrock-agentcore";
import { type ErrorCode, agentError, errorData } from "@fastagent-sh/client/agent-api";
import { statusOf } from "@fastagent-sh/client/http/contract";
import {
  type EnvelopedResponse,
  SESSION_ID_PATTERN,
  envelopeRequest,
  isEventStream,
  unwrapResponse,
} from "./contract.ts";

/** @public */
export interface AgentCoreConnection {
  /** The runtime: `arn:aws:bedrock-agentcore:<region>:<account>:runtime/<id>`. */
  runtimeArn: string;
  /**
   * The session, and so the instance: one per user or chat, kept by the caller. AgentCore's rule: 33 to 256 letters,
   * digits, `-` and `_`, starting with a letter or digit.
   */
  sessionId: string;
  /** The runtime endpoint qualifier (e.g. `prod`). Default: `DEFAULT`. */
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

export function agentCoreTransport({ runtimeArn, sessionId, qualifier }: AgentCoreConnection): {
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
    if (answer.response === undefined) {
      throw new Error("the runtime answered what is not an Agent API envelope: does it run serveAgentCore()?");
    }
    return unwrapResponse(answer.response);
  };
  return { url: `https://${sessionId}.agentcore`, fetch: agentCoreFetch };
}
