/**
 * Server side of the AgentCore invocation envelope (`POST /invocations`): unwraps `EnvelopedRequest` and encodes
 * non-streaming Agent API responses into base64 `EnvelopedResponse`. Paired with `@fastagent-sh/client-agentcore`.
 */

/** An Agent API request, as an invocation carries it. A request's body is JSON text. */
export interface EnvelopedRequest {
  method: string;
  /** The path and query, as `/v1/sessions?limit=10`. */
  path: string;
  headers: Record<string, string>;
  body?: string;
}

/** An Agent API answer that is not an event stream. Its body is base64 (attachments carry raw bytes). */
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
