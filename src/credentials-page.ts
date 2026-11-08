/**
 * The page where a person pastes the values a channel's setup needs, for a setup that has no terminal (a coding agent's
 * `--json`): loopback only, one use, and each value goes from the browser to this process and nowhere else (see
 * setup-page.ts for why it is never the agent's conversation). Each value is checked as it is pasted and handed to
 * `accept` at once, so a step that passed stays accepted when another is refused: the form then asks only for what is left.
 */
import { randomBytes } from "node:crypto";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { SetupRefused } from "./channels/setup.ts";
import type { SetupGuide } from "./channels/setup.ts";
import {
  field,
  formCard,
  openButton,
  privacy,
  prose,
  refusal,
  sendPage,
  setupRequestUrl,
  statusCard,
  step,
  submit,
} from "./setup-page.ts";

/** What the person pastes at one step: its fields are checked together. */
export interface CredentialsStep {
  label: string;
  guide: SetupGuide;
  fields: readonly { name: string; label: string; secret?: boolean }[];
}

export interface CredentialsPage {
  url: string;
  /** Settles once every value was accepted; rejects when `accept` failed for a reason other than a refusal. */
  done: Promise<void>;
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

// A browser can leave during validation, before either response event can be subscribed to.
function afterResponse(response: ServerResponse, complete: () => void): void {
  if (response.destroyed || response.writableFinished) complete();
  else response.once("close", complete);
}

export async function startCredentialsPage(input: {
  /** "Connect Slack". */
  title: string;
  /** What the done page says: "Slack connected". */
  doneHeading: string;
  steps: readonly CredentialsStep[];
  /** Check a step's values and keep them. Throws {@link SetupRefused} to stay on the form with the reason; anything else ends the page. */
  accept(step: number, values: Record<string, string>): Promise<void>;
}): Promise<CredentialsPage> {
  const path = `/setup/${randomBytes(24).toString("hex")}`;
  const { promise: done, resolve, reject } = Promise.withResolvers<void>();
  const accepted = new Set<number>();
  let checking = false;
  let used = false;
  let port = 0;

  const form = (problem?: { step: number; refusal: SetupRefused }): string =>
    formCard(
      input.title,
      input.steps
        .map(({ label, guide, fields }, index) => {
          if (accepted.has(index)) return step(index + 1, label, prose(`Saved.`));
          const here = problem?.step === index ? problem.refusal : undefined;
          return step(
            index + 1,
            label,
            prose(guide.instructions) +
              (guide.url === undefined ? "" : openButton("Open", guide.url)) +
              (here === undefined
                ? ""
                : refusal(here.message, here.fix === undefined ? undefined : ` ${here.fix}`, here.why)) +
              fields
                .map((one, position) =>
                  field({
                    id: one.name,
                    label: one.label,
                    secret: one.secret ?? true,
                    invalid: here !== undefined,
                    autofocus: here !== undefined && position === 0,
                  }),
                )
                .join(""),
          );
        })
        .join("") +
        submit("Save and check") +
        privacy(),
    );

  const server = createServer(async (request, response) => {
    const url = setupRequestUrl(request, response);
    if (url === undefined) return;
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
      sendPage(response, 200, { title: `${input.title} — FastAgent`, card: form() });
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
    try {
      for (const [index, { fields }] of input.steps.entries()) {
        if (accepted.has(index)) continue;
        try {
          const values: Record<string, string> = {};
          for (const { name, label } of fields) {
            const value = (pasted.get(name) ?? "").trim();
            if (value === "") throw new SetupRefused(`${label} is needed.`);
            values[name] = value;
          }
          await input.accept(index, values);
          accepted.add(index);
        } catch (error) {
          // Only a refusal stays on the form; infrastructure and persistence errors end the setup.
          if (!(error instanceof SetupRefused)) throw error;
          checking = false;
          sendPage(response, 200, { title: `${input.title} — FastAgent`, card: form({ step: index, refusal: error }) });
          return;
        }
      }
    } catch (error) {
      checking = false;
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
    afterResponse(response, resolve);
    sendPage(response, 200, {
      title: `${input.doneHeading} — FastAgent`,
      card: statusCard({
        state: "done",
        heading: input.doneHeading,
        lede: "Your coding agent will say if anything is left to do.",
        next: "Go back to your coding agent.",
      }),
    });
  });
  await new Promise<void>((resolveListening, rejectListening) => {
    server.once("error", rejectListening);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListening);
      resolveListening();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("the credentials page did not receive a local TCP port");
  }
  port = address.port;
  return {
    url: `http://127.0.0.1:${port}${path}`,
    done,
    close: () =>
      new Promise<void>((resolveClosed) => {
        server.close(() => resolveClosed());
        server.closeAllConnections();
      }),
  };
}
