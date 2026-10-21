/** The Agent API over Fetch (agent-api.md §10). This binding does not replace the served SPEC v1 plane yet. */
import type * as Schema from "effect/Schema";
import type {
  Agent,
  AgentError,
  CreateSessionOptions,
  InvokeRequest,
  ReadOptions,
  ReplayFrom,
  ResumeEvent,
} from "../agent-api.ts";
import { AgentRejection, agentError } from "../agent-api.ts";
import { CreateBody, EmptyBody, InvokeBody, decodeWire } from "../agent-api-wire.ts";
import type { ChannelHandler } from "../channel.ts";
import { log } from "../log.ts";
import { MAX_BODY_BYTES, readBodyCapped } from "./body.ts";
import { attachmentResponse } from "./attachment-response.ts";
import { httpTable } from "./http-table.ts";
import { assertCorsOrigins, router } from "./router.ts";
import { sseResponse } from "./sse.ts";

const STATUS: Record<string, number> = {
  invalid_request: 400,
  not_found: 404,
  busy: 429,
  missing_model: 422,
  auth_required: 422,
  model_error: 502,
  unavailable: 503,
  internal: 500,
};
const json = (value: unknown, status = 200) => Response.json(value, { status });
const refused = (error: AgentError) => json({ error }, STATUS[error.code] ?? 500);
const invalid = (message: string) => refused(agentError("invalid_request", message));

async function body<T>(request: Request, schema: Schema.Top): Promise<{ value: T } | { error: Response }> {
  const read = await readBodyCapped(request, MAX_BODY_BYTES);
  if ("tooLarge" in read) return { error: invalid("The body is larger than 1 MiB") };
  try {
    return { value: decodeWire<T>(schema, read.text.trim() === "" ? {} : JSON.parse(read.text), true) };
  } catch (error) {
    // This is the untrusted JSON boundary: syntax and schema failures are invalid requests.
    return { error: invalid(`Invalid JSON body: ${String(error)}`) };
  }
}

const answer = (
  result: { ok: true } | { ok: false; error: AgentError } | { ok: false; unknown: object },
  status = 200,
) => {
  const { ok, ...value } = result;
  return ok
    ? json(value, status)
    : "unknown" in result
      ? json({ unknown: result.unknown }, 503)
      : refused(result.error);
};

/** A snapshot's cursor includes entries captured before attachment, even when no replay was requested. */
async function events(agent: Agent, request: Request, url: URL, sessionId: string): Promise<Response> {
  const latest = await agent.read(sessionId, { limit: 1 });
  if (!latest.ok) return refused(latest.error);
  let last = latest.entries.at(-1)?.id ?? "start";
  const header = request.headers.get("last-event-id");
  const after = url.searchParams.get("after");
  const start = header === "start" || (header === null && after === null && url.searchParams.get("replay") === "start");
  const cursor = header ?? after;
  const replay = start || cursor !== null;
  const replayFrom: ReplayFrom =
    start || (cursor === null && last === "start") ? { type: "start" } : { type: "after", entryId: cursor ?? last };
  const iterator = agent.resume(sessionId, { replayFrom })[Symbol.asyncIterator]();
  let head: IteratorResult<ResumeEvent>;
  try {
    head = await iterator.next();
  } catch (error) {
    await iterator.return?.();
    throw error;
  }
  if (!head.done && head.value.type === "rejected") {
    await iterator.return?.();
    return refused(head.value.error);
  }
  let present = false;
  const filtered: AsyncIterable<ResumeEvent> = {
    [Symbol.asyncIterator]: () => ({
      async next() {
        for (;;) {
          const next = head;
          head = { done: true, value: undefined };
          const value = next.done ? await iterator.next() : next;
          if (value.done) return value;
          if (value.value.type === "entry") last = value.value.entry.id;
          if (value.value.type === "state") present = true;
          if (replay || present || value.value.type !== "entry") return value;
        }
      },
      return: async () => (await iterator.return?.()) ?? { done: true, value: undefined },
    }),
  };
  return sseResponse(
    filtered,
    (event) => event,
    (event) => (event.type === "entry" ? event.entry.id : event.type === "state" ? last : undefined),
  );
}

export function createAgentApiHandler(agent: Agent, options: { corsOrigins?: readonly string[] } = {}): ChannelHandler {
  if (options.corsOrigins) assertCorsOrigins(options.corsOrigins, "createAgentApiHandler: corsOrigins");
  const handler = httpTable(
    {
      "GET /agent": () => json(agent.info()),
      "POST /invoke": async (request) => {
        const parsed = await body<InvokeRequest>(request, InvokeBody);
        if ("error" in parsed) return parsed.error;
        try {
          const result = await agent.invoke(parsed.value);
          if (!result.ok) return answer(result);
          const { sessionId, message, duplicate } = result;
          return json({ sessionId, message, duplicate }, 202);
        } catch (error) {
          // A throwing Agent may already have accepted the message; never claim a refusal here.
          log.error(`[agent-api] invoke failed: ${String(error)}`);
          return json(
            {
              unknown: {
                reason: String(error),
                ...(parsed.value.sessionId === undefined ? {} : { sessionId: parsed.value.sessionId }),
              },
            },
            503,
          );
        }
      },
      "POST /sessions": async (request) => {
        const parsed = await body<CreateSessionOptions>(request, CreateBody);
        return "error" in parsed ? parsed.error : answer(await agent.createSession(parsed.value), 201);
      },
      "GET /sessions/{s}": async (_request, url, params) => {
        const limit = url.searchParams.get("limit");
        if (limit !== null && !/^\d+$/.test(limit)) return invalid("limit is a non-negative integer");
        const read: ReadOptions = {};
        for (const name of ["after", "before"] as const) {
          const value = url.searchParams.get(name);
          if (value !== null) read[name] = value;
        }
        if (limit !== null) read.limit = Number(limit);
        return answer(await agent.read(params.s as string, read));
      },
      "GET /sessions/{s}/messages/{m}": async (_request, _url, params) =>
        json((await agent.getMessage(params.s as string, { messageId: params.m as string })) ?? null),
      "GET /sessions/{s}/messages": async (_request, url, params) => {
        const key = url.searchParams.get("idempotencyKey");
        return key === null
          ? invalid("idempotencyKey is required")
          : json((await agent.getMessage(params.s as string, { idempotencyKey: key })) ?? null);
      },
      "GET /sessions/{s}/events": (request, url, params) => events(agent, request, url, params.s as string),
      "POST /sessions/{s}/abort": async (request, _url, params) => {
        const parsed = await body(request, EmptyBody);
        return "error" in parsed
          ? parsed.error
          : answer(await agent.abort(params.s as string, { signal: request.signal }));
      },
      "GET /sessions/{s}/attachments/{ref}": async (_request, _url, params) => {
        return attachmentResponse(await agent.attachment(params.s as string, params.ref as string));
      },
    },
    (request, url, error) => {
      if (error instanceof AgentRejection) {
        return refused({
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          ...(error.details === undefined ? {} : { details: error.details }),
        });
      }
      log.error(`[agent-api] ${request.method} ${url.pathname}: ${String(error)}`);
      return refused(agentError("internal", "The request failed on the server"));
    },
  );
  return router({
    unverified: { "/invoke": handler, "/agent": handler },
    nonJsonBody: () => invalid("content-type must be application/json"),
    mounts: [{ prefix: "/sessions", handler }],
    corsOrigins: options.corsOrigins ?? false,
  });
}
