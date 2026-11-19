/**
 * The Agent API inside AgentCore's invocations. `InvokeAgentRuntime` reaches a runtime only as `POST /invocations`,
 * turns any answer but a 2xx into its own `424 RuntimeClientError` and drops the answer's headers. So a request travels
 * as `{ request }`, and its answer comes back with status 200: as `{ response }` holding the status, headers and body,
 * or, for an event stream the agent opened, as that stream itself, which AgentCore passes through as it is written.
 *
 * Session endpoints would pass the API as it is, but the runtime's `allowedPorts` cannot be set by CloudFormation or
 * the AgentCore CLI yet (aws/agentcore-cli#2811).
 */

/** AgentCore's rule for `runtimeSessionId`: 33 to 256 letters, digits, hyphens and underscores, starting alphanumeric. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{32,255}$/;

/** An Agent API request, as an invocation carries it. A request's body is JSON text. */
export interface EnvelopedRequest {
  method: string;
  /** The path and query, as `/v1/sessions?limit=10`. */
  path: string;
  headers: Record<string, string>;
  body?: string;
}

/** An Agent API answer that is not an event stream. Its body in base64: an attachment is bytes. */
export interface EnvelopedResponse {
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

export function unwrapResponse({ status, headers, body }: EnvelopedResponse): Response {
  const bytes = fromBase64(body);
  // A Response with a null-body status (204, 304) takes no body, not even an empty one.
  return new Response([101, 204, 205, 304].includes(status) ? null : bytes, { status, headers });
}
