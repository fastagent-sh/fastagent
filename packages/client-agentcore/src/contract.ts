/**
 * Client side of the AgentCore invocation envelope (`InvokeAgentRuntime`): encodes `Request` into
 * `EnvelopedRequest` and unwraps base64 `EnvelopedResponse` back into a Fetch `Response`.
 * Paired with `@fastagent-sh/agentcore`.
 */

/** AgentCore's rule for `runtimeSessionId`: 33 to 256 letters, digits, hyphens and underscores, starting alphanumeric. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{32,255}$/;

interface EnvelopedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}

export interface EnvelopedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export const isEventStream = (contentType: string | null | undefined): boolean =>
  contentType?.split(";")[0]?.trim() === "text/event-stream";

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function envelopeRequest(request: Request): Promise<EnvelopedRequest> {
  const url = new URL(request.url);
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    if (name !== "authorization" && name !== "host" && name !== "content-length") headers[name] = value;
  });
  const body = request.body === null ? undefined : await request.text();
  return { method: request.method, path: url.pathname + url.search, headers, ...(body === undefined ? {} : { body }) };
}

export function unwrapResponse({ status, headers, body }: EnvelopedResponse): Response {
  const bytes = fromBase64(body);
  return new Response([101, 204, 205, 304].includes(status) ? null : bytes, { status, headers });
}
