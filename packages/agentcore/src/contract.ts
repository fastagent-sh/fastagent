/**
 * Server side of the AgentCore invocation envelope (`POST /invocations`): unwraps `EnvelopedRequest` and encodes
 * non-streaming Agent API responses into base64 `EnvelopedResponse`. Paired with `@fastagent-sh/client-agentcore`.
 */

export interface EnvelopedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}

interface EnvelopedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export const isEventStream = (contentType: string | null | undefined): boolean =>
  contentType?.split(";")[0]?.trim() === "text/event-stream";

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export async function envelopeResponse(response: Response): Promise<EnvelopedResponse> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  return {
    status: response.status,
    headers,
    body: toBase64(new Uint8Array(await response.arrayBuffer())),
  };
}
