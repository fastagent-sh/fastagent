import { randomBytes } from "node:crypto";
import { type IncomingMessage, createServer } from "node:http";

export interface SlackSetupServer {
  port: number;
  requestPath: string;
  redirectPath: string;
  /**
   * The page a person pastes an App Configuration token pair on, for a setup a coding agent runs: the pair never
   * passes through the agent's conversation or any file. Its path is the server's secret, like the OAuth redirect's.
   */
  tokensPath: string;
  /** The pair, once one `check` accepts is pasted; what `check` throws is shown on the page, which stays up. */
  waitForTokens<T>(check: (pair: { access: string; refresh: string }) => T): Promise<T>;
  /** Where the browser that pasted the pair goes next: Slack's install page. */
  next(url: string): void;
  /**
   * Why the setup stopped, for a browser waiting on the page after the pair: resolves once it has been shown, at once
   * when no browser waits there, or after one refresh window, so a setup can stop without leaving it on a dead page.
   */
  failed(message: string): Promise<void>;
  waitForOAuth(timeoutMs?: number): Promise<{ code?: string; state?: string; error?: string }>;
  close(): Promise<void>;
}

const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const page = (body: string, head = "") =>
  `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width">${head}` +
  `<title>FastAgent Slack setup</title><body style="font:16px system-ui;max-width:40em;margin:3em auto;padding:0 1em">${body}`;

function tokensForm(error?: string): string {
  return page(
    `<h1>Slack App Configuration token</h1>` +
      `<ol><li>Open <a href="https://api.slack.com/apps" target=_blank rel=noopener>api.slack.com/apps</a>, then ` +
      `<b>Your App Configuration Tokens</b> → <b>Generate Token</b> for the workspace the agent joins.</li>` +
      `<li>Paste both tokens here.</li></ol>` +
      `<p>FastAgent keeps them on this machine only (owner-readable), uses them to create the app and update its ` +
      `Request URL, and never deploys them.</p>` +
      (error ? `<p style="color:#b00"><b>${escapeHtml(error)}</b></p>` : "") +
      `<form method=post><p><label>Access token<br><input name=access type=password required ` +
      `placeholder="xoxe.xoxp-…" style="width:100%"></label></p><p><label>Refresh token<br><input name=refresh ` +
      `type=password required placeholder="xoxe-…" style="width:100%"></label></p>` +
      `<p><button>Create the Slack app</button></p></form>`,
  );
}

/** Temporary onboarding-only responder. */
export async function startSlackSetupServer(): Promise<SlackSetupServer> {
  const nonce = randomBytes(24).toString("hex");
  const requestPath = `/slack/setup/${nonce}`;
  const redirectPath = `/slack/oauth/${nonce}`;
  const tokensPath = `/slack/tokens/${nonce}`;
  const nextPath = `/slack/next/${nonce}`;
  let takeTokens: ((pair: { access: string; refresh: string }) => void) | undefined;
  let pasted = false;
  let after: { url: string } | { error: string } | undefined;
  let errorShown: (() => void) | undefined;
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
        page("<p>Slack authorization received: FastAgent is finishing the install. You can close this page.</p>"),
      );
      return;
    }
    if (url.pathname === tokensPath && (request.method === "GET" || request.method === "POST")) {
      response.setHeader("content-type", "text/html; charset=utf-8");
      if (takeTokens === undefined) {
        // Taken already, or not asked for: the page is one-time.
        response.statusCode = 404;
        response.end(page("<p>This page is no longer in use.</p>"));
        return;
      }
      if (request.method === "GET") {
        response.end(tokensForm());
        return;
      }
      readBody(request, (body) => {
        if (body === undefined) {
          response.statusCode = 413;
          response.end(page("<p>Too large.</p>"));
          return;
        }
        const form = new URLSearchParams(body);
        try {
          takeTokens?.({ access: (form.get("access") ?? "").trim(), refresh: (form.get("refresh") ?? "").trim() });
        } catch (error) {
          response.end(tokensForm((error as Error).message));
          return;
        }
        response.statusCode = 303;
        response.setHeader("location", nextPath);
        response.end();
      });
      return;
    }
    if (request.method === "GET" && url.pathname === nextPath) {
      response.setHeader("content-type", "text/html; charset=utf-8");
      if (after === undefined) {
        response.end(page("<p>Creating the Slack app…</p>", '<meta http-equiv="refresh" content="2">'));
      } else if ("url" in after) {
        response.statusCode = 303;
        response.setHeader("location", after.url);
        response.end();
      } else {
        response.end(page(`<p style="color:#b00"><b>${escapeHtml(after.error)}</b></p><p>Return to your agent.</p>`));
        errorShown?.();
      }
      return;
    }
    if (request.method === "POST" && url.pathname === requestPath) {
      readBody(request, (body) => {
        if (body === undefined) {
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
    tokensPath,
    waitForTokens: (check) =>
      new Promise((resolve) => {
        takeTokens = (pair) => {
          const taken = check(pair);
          takeTokens = undefined;
          pasted = true;
          resolve(taken);
        };
      }),
    next(url) {
      after = { url };
    },
    failed(message) {
      if (!pasted || after !== undefined) return Promise.resolve();
      after = { error: message };
      return new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5_000);
        errorShown = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    },
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

/** A request's body, or `undefined` past 64 KB: setup traffic is small, and anything larger is not ours. */
function readBody(request: IncomingMessage, then: (body: string | undefined) => void): void {
  let body = "";
  let tooLarge = false;
  request.on("data", (chunk: Buffer) => {
    if (tooLarge) return;
    body += String(chunk);
    if (Buffer.byteLength(body) > 64 * 1024) tooLarge = true;
  });
  request.on("end", () => then(tooLarge ? undefined : body));
}
