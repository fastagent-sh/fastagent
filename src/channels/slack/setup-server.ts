import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

export interface SlackSetupServer {
  port: number;
  requestPath: string;
  redirectPath: string;
  waitForOAuth(timeoutMs?: number): Promise<{ code?: string; state?: string; error?: string }>;
  close(): Promise<void>;
}

/**
 * Temporary onboarding-only responder. Its unguessable paths live for one command: one path echoes only
 * Slack's URL-verification challenge, while the other captures one OAuth redirect. It never accepts
 * event callbacks or runs Agent work.
 */
export async function startSlackSetupServer(): Promise<SlackSetupServer> {
  const nonce = randomBytes(24).toString("hex");
  const requestPath = `/slack/setup/${nonce}`;
  const redirectPath = `/slack/oauth/${nonce}`;
  let settleOAuth: ((value: { code?: string; state?: string; error?: string }) => void) | undefined;
  const oauth = new Promise<{ code?: string; state?: string; error?: string }>((resolve) => {
    settleOAuth = resolve;
  });

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/health") {
      response.end("ok\n");
      return;
    }
    if (request.method === "GET" && url.pathname === redirectPath) {
      settleOAuth?.({
        code: url.searchParams.get("code") ?? undefined,
        state: url.searchParams.get("state") ?? undefined,
        error: url.searchParams.get("error") ?? undefined,
      });
      settleOAuth = undefined;
      response.statusCode = 200;
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(
        "<!doctype html><title>FastAgent Slack setup</title><p>Slack authorization received. Return to your terminal.</p>",
      );
      return;
    }
    if (request.method === "POST" && url.pathname === requestPath) {
      let body = "";
      let tooLarge = false;
      request.on("data", (chunk: Buffer) => {
        if (tooLarge) return;
        body += String(chunk);
        if (Buffer.byteLength(body) > 64 * 1024) tooLarge = true;
      });
      request.on("end", () => {
        if (tooLarge) {
          response.statusCode = 413;
          response.end("payload too large\n");
          return;
        }
        try {
          const payload = JSON.parse(body) as { type?: string; challenge?: string };
          if (payload.type === "url_verification" && typeof payload.challenge === "string") {
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify({ challenge: payload.challenge }));
            return;
          }
        } catch {
          // Fall through: setup never acknowledges normal events or malformed traffic.
        }
        response.statusCode = 404;
        response.end("not found\n");
      });
      return;
    }
    response.statusCode = 404;
    response.end("not found\n");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Slack setup server did not receive a local TCP port");
  }

  return {
    port: address.port,
    requestPath,
    redirectPath,
    async waitForOAuth(timeoutMs = 10 * 60_000) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Slack OAuth timed out — re-run `fastagent add slack`")), timeoutMs);
        timer.unref();
      });
      try {
        return await Promise.race([oauth, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
