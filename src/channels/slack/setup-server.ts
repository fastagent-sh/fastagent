import { randomBytes } from "node:crypto";
import { type IncomingMessage, createServer } from "node:http";
import {
  field,
  formCard,
  openButton,
  privacy,
  prose,
  refusal,
  sendPage,
  statusCard,
  step,
  submit,
} from "../../setup-page.ts";

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
  /** What the setup did, for a browser waiting on that page when the setup ends there (a saved pair replaced), as `failed`. */
  done(message: string): Promise<void>;
  waitForOAuth(timeoutMs?: number): Promise<{ code?: string; state?: string; error?: string }>;
  close(): Promise<void>;
}

/** Where Slack's App Configuration tokens are generated: the page names the section, and links to the page it is on. */
const SLACK_APPS_URL = "https://api.slack.com/apps";

const TITLE = "Connect Slack — FastAgent";

function tokensForm(error?: string): { title: string; card: string } {
  return {
    title: TITLE,
    card: formCard(
      "Connect Slack",
      [
        step(
          1,
          "Generate two tokens in Slack",
          prose("Under <b>Your App Configuration Tokens</b>, choose <b>Generate Token</b> for your workspace.") +
            openButton("Open Slack", SLACK_APPS_URL),
        ),
        step(
          2,
          "Paste them here",
          (error ? refusal("Those tokens were not accepted.", ` ${error}`) : "") +
            field({
              id: "access",
              label: "Access Token",
              placeholder: "xoxe.xoxp-…",
              secret: true,
              invalid: error !== undefined,
              autofocus: error !== undefined,
            }) +
            field({
              id: "refresh",
              label: "Refresh Token",
              placeholder: "xoxe-…",
              secret: true,
              invalid: error !== undefined,
            }) +
            submit("Create Slack app") +
            privacy(),
          { bare: error === undefined },
        ),
      ].join(""),
    ),
  };
}

/** A page that says where the setup stands. */
const status = (input: Parameters<typeof statusCard>[0], title = "FastAgent setup") => ({
  title,
  card: statusCard(input),
});

/** Temporary onboarding-only responder. */
export async function startSlackSetupServer(): Promise<SlackSetupServer> {
  const nonce = randomBytes(24).toString("hex");
  const requestPath = `/slack/setup/${nonce}`;
  const redirectPath = `/slack/oauth/${nonce}`;
  const tokensPath = `/slack/tokens/${nonce}`;
  const nextPath = `/slack/next/${nonce}`;
  let takeTokens: ((pair: { access: string; refresh: string }) => void) | undefined;
  let pasted = false;
  let after: { url: string } | { said: string; failed: boolean } | undefined;
  let lastShown: (() => void) | undefined;
  /** The last page a browser waiting after the pair sees, and when it has seen it (bounded by one refresh window). */
  const lastPage = (said: string, failed: boolean): Promise<void> => {
    if (!pasted || after !== undefined) return Promise.resolve();
    after = { said, failed };
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      lastShown = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  };
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
      sendPage(
        response,
        200,
        status({
          state: "done",
          heading: "Slack allowed the app",
          lede: "FastAgent is finishing the install.",
          next: "You can close this tab and go back to your coding agent.",
        }),
      );
      return;
    }
    if (url.pathname === tokensPath && (request.method === "GET" || request.method === "POST")) {
      if (takeTokens === undefined) {
        // Taken already, or not asked for: the page is one-time.
        sendPage(
          response,
          404,
          status({ state: "failed", heading: "This page is no longer in use", next: "Go back to your coding agent." }),
        );
        return;
      }
      if (request.method === "GET") {
        sendPage(response, 200, tokensForm());
        return;
      }
      readBody(request, (body) => {
        if (body === undefined) {
          response.statusCode = 413;
          response.end("payload too large\n");
          return;
        }
        const form = new URLSearchParams(body);
        try {
          takeTokens?.({ access: (form.get("access") ?? "").trim(), refresh: (form.get("refresh") ?? "").trim() });
        } catch (error) {
          sendPage(response, 200, tokensForm((error as Error).message));
          return;
        }
        response.statusCode = 303;
        response.setHeader("location", nextPath);
        response.end();
      });
      return;
    }
    if (request.method === "GET" && url.pathname === nextPath) {
      if (after === undefined) {
        // Says what comes next, so the redirect to Slack's page is no surprise.
        sendPage(response, 200, {
          ...status({
            state: "working",
            heading: "Creating your Slack app",
            lede: "In a moment Slack will ask you to click Allow.",
          }),
          head: '<meta http-equiv="refresh" content="2">',
        });
      } else if ("url" in after) {
        response.statusCode = 303;
        response.setHeader("location", after.url);
        response.end();
      } else {
        sendPage(
          response,
          200,
          status({
            state: after.failed ? "failed" : "done",
            heading: after.failed ? "Setup stopped" : "Done",
            lede: after.said,
            next: "Go back to your coding agent.",
          }),
        );
        lastShown?.();
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
    failed: (message) => lastPage(message, true),
    done: (message) => lastPage(message, false),
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
