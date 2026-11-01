/** Loopback-only, single-use forms for Lark setup secrets; values never pass through the agent's conversation. */
import { randomBytes } from "node:crypto";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
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

export interface LarkCredentials {
  appId: string;
  appSecret: string;
}

export class LarkCredentialsRefused extends Error {
  readonly fix: string | undefined;
  readonly why: string | undefined;
  constructor(headline: string, options: { fix?: string; why?: string } = {}) {
    super(headline);
    this.name = "LarkCredentialsRefused";
    this.fix = options.fix;
    this.why = options.why;
  }
}

export interface LarkCredentialsPage<T = LarkCredentials> {
  url: string;
  credentials: Promise<T>;
  close(): Promise<void>;
}

function readBody(request: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve) => {
    let body = "";
    let tooLarge = false;
    request.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      body += String(chunk);
      if (Buffer.byteLength(body) > 16 * 1024) tooLarge = true;
    });
    request.on("end", () => resolve(tooLarge ? undefined : body));
    request.on("error", () => resolve(undefined));
  });
}

export function startLarkCredentialsPage(input: {
  consoleUrl: string;
  check(credentials: LarkCredentials): Promise<void>;
}): Promise<LarkCredentialsPage> {
  return startPage({
    heading: "Lark credentials verified",
    form: (pasted, problem) =>
      formCard(
        "Connect Lark",
        [
          step(
            1,
            "Create the app in Lark",
            prose("It opens with the permissions and event your agent needs already set.") +
              openButton("Open Lark", input.consoleUrl),
          ),
          step(
            2,
            "Paste its credentials",
            (problem
              ? refusal(problem.message, problem.fix, problem.why)
              : prose("Find them under <b>Credentials &amp; Basic Info</b>.")) +
              field({
                id: "app_id",
                label: "App ID",
                placeholder: "cli_…",
                value: pasted.get("app_id") ?? "",
                invalid: !!problem,
              }) +
              field({ id: "app_secret", label: "App Secret", secret: true, invalid: !!problem, autofocus: !!problem }) +
              submit("Save and check") +
              privacy(),
          ),
        ].join(""),
      ),
    accept: async (pasted) => {
      const pair = { appId: (pasted.get("app_id") ?? "").trim(), appSecret: (pasted.get("app_secret") ?? "").trim() };
      if (!pair.appId || !pair.appSecret) {
        throw new LarkCredentialsRefused("Both values are needed.", {
          fix: "Copy the App ID and the App Secret from Credentials & Basic Info.",
        });
      }
      await input.check(pair);
      return pair;
    },
  });
}

export function startLarkVerificationPage(input: {
  consoleUrl: string;
  save(token: string): Promise<void>;
}): Promise<LarkCredentialsPage<string>> {
  return startPage({
    heading: "Verification Token saved",
    form: (_pasted, problem) =>
      formCard(
        "Finish Lark webhook setup",
        [
          step(
            1,
            "Copy the Verification Token",
            prose(
              "Find it under <b>Events &amp; Callbacks</b> → Encryption Strategy. Choose webhook mode when setting the Request URL.",
            ) + openButton("Open Lark", input.consoleUrl),
          ),
          step(
            2,
            "Paste the token here",
            (problem ? refusal(problem.message, problem.fix) : "") +
              field({
                id: "verification_token",
                label: "Verification Token",
                secret: true,
                invalid: !!problem,
                autofocus: !!problem,
              }) +
              submit("Save token") +
              privacy(),
          ),
        ].join(""),
      ),
    accept: async (pasted) => {
      const token = (pasted.get("verification_token") ?? "").trim();
      if (!token) throw new LarkCredentialsRefused("Verification Token is required.");
      await input.save(token);
      return token;
    },
  });
}

// A browser can leave during validation, before either response event can be subscribed to.
function afterResponse(response: ServerResponse, complete: () => void): void {
  if (response.destroyed || response.writableFinished) complete();
  else response.once("close", complete);
}

async function startPage<T>(input: {
  heading: string;
  form(pasted: URLSearchParams, problem?: LarkCredentialsRefused): string;
  accept(pasted: URLSearchParams): Promise<T>;
}): Promise<LarkCredentialsPage<T>> {
  const path = `/lark/credentials/${randomBytes(24).toString("hex")}`;
  const { promise: credentials, resolve, reject } = Promise.withResolvers<T>();
  let checking = false;
  let used = false;
  let port = 0;

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const host = request.headers.host ?? "";
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      response.writeHead(421).end("misdirected request\n");
      return;
    }
    if (url.pathname !== path || (request.method !== "GET" && request.method !== "POST")) {
      response.writeHead(404).end("not found\n");
      return;
    }
    const expired = () =>
      sendPage(response, 404, {
        title: "FastAgent setup",
        card: statusCard({
          state: "failed",
          heading: "This page is no longer in use",
          next: "Go back to your coding agent.",
        }),
      });
    if (used) {
      expired();
      return;
    }
    if (request.method === "GET") {
      sendPage(response, 200, { title: "Connect Lark — FastAgent", card: input.form(new URLSearchParams()) });
      return;
    }
    const site = request.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin") {
      response.writeHead(403).end("forbidden\n");
      return;
    }
    const body = await readBody(request);
    if (body === undefined) {
      response.writeHead(413).end("payload too large\n");
      return;
    }
    if (used) {
      expired();
      return;
    }
    if (checking) {
      response.writeHead(409).end("another submission is being checked\n");
      return;
    }
    checking = true;
    const pasted = new URLSearchParams(body);
    let accepted: T;
    try {
      accepted = await input.accept(pasted);
    } catch (error) {
      checking = false;
      // Only explicit input refusals stay on the form. Infrastructure and persistence errors fail the ticket.
      if (error instanceof LarkCredentialsRefused) {
        sendPage(response, 200, { title: "Connect Lark — FastAgent", card: input.form(pasted, error) });
        return;
      }
      used = true;
      afterResponse(response, () => reject(error));
      sendPage(response, 200, {
        title: "Setup stopped — FastAgent",
        card: statusCard({
          state: "failed",
          heading: "Setup stopped",
          lede: error instanceof Error ? error.message : String(error),
          next: "Go back to your coding agent.",
        }),
      });
      return;
    }
    used = true;
    afterResponse(response, () => resolve(accepted));
    sendPage(response, 200, {
      title: `${input.heading} — FastAgent`,
      card: statusCard({
        state: "done",
        heading: input.heading,
        lede: "Your coding agent will say if anything is left to do in Lark.",
        next: "Go back to your coding agent.",
      }),
    });
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
    throw new Error("the Lark credentials page did not receive a local TCP port");
  }
  port = address.port;
  return {
    url: `http://127.0.0.1:${port}${path}`,
    credentials,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
