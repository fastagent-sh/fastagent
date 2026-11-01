/**
 * Where a person pastes a Lark app's App ID and App Secret, for a setup a coding agent runs: they go from the browser to
 * this process, are checked against Lark, and only then are handed on to be written. They never pass through the agent's
 * conversation, and the person never has to edit a file (a command typed into the same window as the agent is read by it).
 *
 * A one-time page on this machine: bound to loopback, its path a random secret, a request from another origin or under
 * another host name refused (a page elsewhere in the browser must not be able to post to it).
 */
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

export interface LarkCredentials {
  appId: string;
  appSecret: string;
}

export interface LarkCredentialsPage {
  /** Where the person goes. */
  url: string;
  /** The credentials `check` accepted. Resolves once the page that says so has been sent. */
  credentials: Promise<LarkCredentials>;
  close(): Promise<void>;
}

/** A request's body, or `undefined` past 16 KB: two short values are all this page takes. */
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

function form(
  consoleUrl: string,
  problem?: { headline: string; detail?: string; why?: string },
  appId?: string,
): string {
  const invalid = problem !== undefined;
  return formCard(
    "Connect Lark",
    [
      step(
        1,
        "Create the app in Lark",
        prose("It opens with the permissions and event your agent needs already set.") +
          openButton("Open Lark", consoleUrl),
      ),
      step(
        2,
        "Paste its credentials",
        (problem
          ? refusal(problem.headline, problem.detail, problem.why)
          : prose("Find them under <b>Credentials &amp; Basic Info</b>.")) +
          field({ id: "app_id", label: "App ID", placeholder: "cli_…", ...(appId ? { value: appId } : {}), invalid }) +
          field({ id: "app_secret", label: "App Secret", secret: true, invalid, autofocus: invalid }) +
          submit("Save and check") +
          privacy(),
      ),
    ].join(""),
  );
}

/**
 * Serve the page. `check` is asked about each pair pasted: it throws to refuse it (the page shows why, keeps the App ID,
 * and asks again), and returns once Lark accepts it.
 */
export async function startLarkCredentialsPage(input: {
  /** Lark's launcher, with what the channel needs set on the app it creates. */
  consoleUrl: string;
  check(credentials: LarkCredentials): Promise<void>;
}): Promise<LarkCredentialsPage> {
  const path = `/lark/credentials/${randomBytes(24).toString("hex")}`;
  let settle: ((credentials: LarkCredentials) => void) | undefined;
  const credentials = new Promise<LarkCredentials>((resolve) => {
    settle = resolve;
  });
  let checking = false;
  let used = false;
  let port = 0;

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    // A DNS-rebinding page reaches this server under its own name; a form on another site posts with another origin.
    const host = request.headers.host ?? "";
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      response.statusCode = 421;
      response.end("misdirected request\n");
      return;
    }
    if (url.pathname !== path || (request.method !== "GET" && request.method !== "POST")) {
      response.statusCode = 404;
      response.end("not found\n");
      return;
    }
    if (used) {
      sendPage(response, 404, {
        title: "FastAgent setup",
        card: statusCard({
          state: "failed",
          heading: "This page is no longer in use",
          next: "Go back to your coding agent.",
        }),
      });
      return;
    }
    if (request.method === "GET") {
      sendPage(response, 200, { title: "Connect Lark — FastAgent", card: form(input.consoleUrl) });
      return;
    }
    const site = request.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin") {
      response.statusCode = 403;
      response.end("forbidden\n");
      return;
    }
    const body = await readBody(request);
    if (body === undefined) {
      response.statusCode = 413;
      response.end("payload too large\n");
      return;
    }
    const pasted = new URLSearchParams(body);
    const pair = { appId: (pasted.get("app_id") ?? "").trim(), appSecret: (pasted.get("app_secret") ?? "").trim() };
    const again = (headline: string, detail?: string, why?: string) =>
      sendPage(response, 200, {
        title: "Connect Lark — FastAgent",
        card: form(input.consoleUrl, { headline, ...(detail ? { detail } : {}), ...(why ? { why } : {}) }, pair.appId),
      });
    if (!pair.appId || !pair.appSecret) {
      again("Both values are needed.", " Copy the App ID and the App Secret from Credentials & Basic Info.");
      return;
    }
    if (checking) {
      again("Still checking the last values.", " Wait a moment, then try again.");
      return;
    }
    checking = true;
    try {
      await input.check(pair);
    } catch (error) {
      checking = false;
      again(
        "Lark refused that App ID or Secret.",
        " Copy both again from Credentials & Basic Info.",
        `Lark said: ${(error as Error).message}`,
      );
      return;
    }
    used = true;
    // What this page can say is what it knows: the pair works. Whether the app still needs a step in Lark is the agent's to say.
    sendPage(response, 200, {
      title: "Lark credentials verified — FastAgent",
      card: statusCard({
        state: "done",
        heading: "Lark credentials verified",
        lede: "Your coding agent takes it from here, and will say if anything is left to do in Lark.",
        next: "Go back to your coding agent.",
      }),
    });
    response.once("finish", () => settle?.(pair));
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
