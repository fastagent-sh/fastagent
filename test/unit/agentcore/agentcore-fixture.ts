import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, vi } from "vitest";
import { SESSION_HEADER } from "@fastagent-sh/agentcore";

type Refused = { error: { code: string; message: string; retryable: boolean } };

export const RUNTIME = "arn:aws:bedrock-agentcore:ap-southeast-1:123456789012:runtime/support-a1b2c3d4e5";

export const invocation = (session: string | undefined, body: unknown) =>
  new Request("http://runtime/invocations", {
    method: "POST",
    headers: { "content-type": "application/json", ...(session === undefined ? {} : { [SESSION_HEADER]: session }) },
    body: JSON.stringify(body),
  });

export async function answered(response: Response) {
  const { response: inner } = (await response.json()) as {
    response: { status: number; headers: Record<string, string>; body: string };
  };
  return {
    status: inner.status,
    headers: inner.headers,
    body: JSON.parse(Buffer.from(inner.body, "base64").toString()) as Refused,
  };
}

export function installFakeAgentCore() {
  const fake = {
    serving: undefined as { fetch(request: Request): Promise<Response> } | undefined,
    signatures: [] as string[],
    urls: [] as string[],
    refusals: [] as Array<{ status: number; type: string }>,
    refuse(status: number, type: string) {
      this.refusals.push({ status, type });
    },
  };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    fake.signatures.push(String(req.headers.authorization));
    fake.urls.push(String(req.url));
    const refusal = fake.refusals.shift();
    if (refusal !== undefined || fake.serving === undefined) {
      const { status, type } = refusal ?? { status: 404, type: "ResourceNotFoundException" };
      res.writeHead(status, { "content-type": "application/json", "x-amzn-errortype": type });
      res.end(JSON.stringify({ message: "refused here" }));
      return;
    }
    const session = String(req.headers[SESSION_HEADER] ?? "");
    const delivered = await fake.serving.fetch(invocation(session, JSON.parse(Buffer.concat(chunks).toString())));
    if (delivered.status >= 300) {
      res.writeHead(424, { "content-type": "application/json", "x-amzn-errortype": "RuntimeClientError" });
      res.end(JSON.stringify({ message: `Received error (${delivered.status}) from runtime.` }));
      return;
    }
    res.writeHead(delivered.status, { "content-type": delivered.headers.get("content-type") ?? "" });
    for await (const chunk of delivered.body ?? []) res.write(chunk);
    res.end();
  });

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    vi.stubEnv("AWS_ENDPOINT_URL_BEDROCK_AGENTCORE", `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIDEXAMPLE");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "secret");
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  return function agentCore(handler: { fetch(request: Request): Promise<Response> }) {
    fake.serving = handler;
    fake.signatures.length = 0;
    fake.urls.length = 0;
    fake.refusals.length = 0;
    return {
      signatures: fake.signatures,
      urls: fake.urls,
      refuse: (status: number, type: string) => fake.refuse(status, type),
      close: async () => {
        fake.serving = undefined;
      },
    };
  };
}
