/**
 * `POST /run` — **an API**: run a unit of work this definition declares, by name.
 *
 * NOT A TIME TRIGGER, and the difference is the whole design. Occurrence semantics — a slot, a claim, a fire
 * history, an overlap policy — exist exactly where fastagent OWNS the clock: the resident loop in `dev`/`start`,
 * and AgentCore, where `deploy` writes the EventBridge rule, injects the instant and relays it through an ingress
 * secret (channels/agentcore.ts). Both of those know which occurrence a run is for because they produced it.
 *
 * This route is the other case: somebody else's clock, CI job, button or script. It cannot be told which occurrence
 * it means, and pretending otherwise was measurably worse than admitting it. The attempt cost four rounds — an
 * instant dated ahead poisoned the claim gate permanently, one off the grid minted a claim no occurrence would ever
 * match, an old one replayed history a turn at a time, and the grid arithmetic all three needed was ~6ms of
 * synchronous CPU per request on an anonymous route. A platform cron drifting a few minutes then lost an occurrence
 * outright (Railway documents "a few minutes" of variance; measured: 3 fires, 2 turns).
 *
 * So the contract is the one an API has:
 *
 *   - the body names WHAT to run and nothing else — the prompt stays in the definition, which is the whole reason
 *     this exists beside `POST /invoke`, whose caller brings its own text and therefore its own behaviour
 *   - the reply says what happened and WHERE TO LOOK (the session the turn ran in). Retry policy is the caller's,
 *     because only the caller knows whether its work tolerates running twice
 *   - it is exactly as exposed as `POST /invoke`: unauthenticated, full tool authority, `http.invoke: false` and a
 *     gateway in front are the answers. The framework authenticates nothing (docs/design/session-control.md §14),
 *     and the previous version's per-occurrence rate ceiling was a bound that looked like a security property
 *     while `/invoke` sat open on the same port
 *
 * AND NO IDEMPOTENCY KEY. One was built here and removed: it deduplicated the CALL, not the WORK. A turn that sent
 * one message and then died would answer a keyed retry with "already ran" — safety exactly where it is absent,
 * which is the same reason a failed fire is not retried (schedule/scheduler.ts). It was also a bounded window, so
 * the guarantee came with an asterisk, and `POST /invoke` offers none of it on the same port under the same
 * exposure. What makes a retry safe is idempotent WORK, which only the author can arrange.
 *
 * NAME IN THE BODY, not the path. A declared name is a filename (`每日简报`, `my schedule` are both legal), and a
 * path segment would mean percent-encoding it — the cost the control plane pays for session ids and this route has
 * no reason to. It also keeps the shape of `POST /invoke`, whose scope rides in the body for the same reason.
 */
import * as Effect from "effect/Effect";
import type { Agent } from "../agent.ts";
import { readBodyCapped, refuseNonJsonBody } from "../channels/body.ts";
import { text } from "../channels/respond.ts";
import { type LoadedRoutine, routineSession } from "./routine.ts";
import { runTurn } from "./scheduler.ts";

/** A trigger body is a name; the cap only has to admit that. */
const MAX_RUN_BODY_BYTES = 4 * 1024;

/**
 * How much of a caller's `name` a 404 will quote back — the ONE thing this route echoes, because telling a typo
 * from a stale caller needs the name and nothing else does. Long enough to recognise one, short enough not to be a
 * page.
 */
export const MAX_ECHOED_NAME = 64;

/** The Effect boundary, in one place: the turn runs, and its outcome is what the caller reads. */
const runOnce = (agent: Agent, routine: LoadedRoutine) =>
  Effect.runPromise(runTurn(agent, routine.name, routineSession(routine.name), routine.prompt));

/** The reply shape both doors answer with — one for the route, one for a host that has no route (AgentCore). */
export interface RoutineRunReply {
  name: string;
  /** WHERE TO LOOK: the turn's output lives in this session's journal (`fastagent routine history`, `/control/*`). */
  session: string;
  ran: boolean;
  /** Present when `ran: false` — today, the previous turn still holding this routine's one session. */
  reason?: string;
  /** Present when the turn RAN and did not finish. */
  failed?: string;
  ms: number;
}

/**
 * Run one routine and say what happened. THE one implementation, because there are two doors and only one
 * contract: `POST /run` on any host that publishes routes, and AgentCore's IAM-gated `routine-run` envelope on the
 * host that publishes none. A second copy is how the two would come to answer differently.
 */
export async function runRoutineByName(agent: Agent, routine: LoadedRoutine): Promise<RoutineRunReply> {
  const session = routineSession(routine.name);
  const { busy, failed, ms } = await runOnce(agent, routine);
  // BUSY IS NOT A FAILURE and it is the one "did not run" this has: a declared unit of work has ONE session, so a
  // call arriving while the previous turn holds it is refused by that session. Reported as itself, with what the
  // caller needs in order to decide — try later — rather than as an error it would retry blindly.
  if (busy) {
    return {
      name: routine.name,
      session,
      ran: false,
      reason: `the previous turn of "${routine.name}" is still running`,
      ms,
    };
  }
  return { name: routine.name, session, ran: true, ...(failed !== undefined ? { failed } : {}), ms };
}

/**
 * Build the handler for `GET /routines` — what a caller may ask for by name.
 *
 * DISCOVERY, because the alternative was a 404. The names were already public: `POST /run` lists them when a caller
 * gets one wrong, which is deliberate (an operator has to tell a typo from a stale caller) — so the only thing this
 * adds is not having to guess wrong first. "Expose a declared prompt as an API" is half a sentence without it.
 *
 * NAMES AND SCHEDULES, NEVER PROMPTS. What a routine SAYS is the definition's content; handing it to an
 * unauthenticated caller would publish the agent's behaviour, which is the one thing keeping the prompt out of the
 * request body was for. `cron` is here because it answers "will this run on its own, or is my clock the only one?",
 * which is a caller's question, not the definition's secret.
 *
 * Mounted exactly where `POST /run` is: it describes that route, so listing names a caller cannot use would be a
 * catalogue of nothing.
 */
export function createRoutineListHandler(options: {
  routines: readonly LoadedRoutine[];
}): ((req: Request) => Promise<Response>) | undefined {
  const { routines } = options;
  if (routines.length === 0) return undefined;
  const body = routines.map((r) => ({
    name: r.name,
    ...(r.cron !== undefined ? { cron: r.cron } : {}),
    ...(r.tz !== undefined ? { tz: r.tz } : {}),
  }));
  // NO METHOD CHECK. The router dispatches `GET /routines` here and nothing else, so the only thing such a check
  // could reach is HEAD — which `channels/serve.ts` deliberately answers with the GET route, the same way
  // `GET /health` is HEAD-probeable. Checking would break that and buy nothing.
  return async () => Response.json(body);
}

/**
 * Build the handler for `POST /run`, bound to what this serve loaded.
 *
 * `undefined` when the definition declares nothing runnable: a route that can only ever answer 404 is not a route,
 * and the startup report names what is actually mounted.
 */
export function createRunHandler(options: {
  agent: Agent;
  routines: readonly LoadedRoutine[];
}): ((req: Request) => Promise<Response>) | undefined {
  const { agent, routines } = options;
  if (routines.length === 0) return undefined;

  return async (req) => {
    if (req.method !== "POST") return text("POST only\n", 405);
    const wrongType = refuseNonJsonBody(req);
    if (wrongType) return wrongType;
    const body = await readBodyCapped(req, MAX_RUN_BODY_BYTES);
    if ("tooLarge" in body) return text("body too large\n", 413);

    let payload: unknown;
    try {
      payload = JSON.parse(body.text);
    } catch {
      return text("invalid json\n", 400);
    }
    const { name } = (payload ?? {}) as { name?: unknown };
    if (typeof name !== "string" || name === "") {
      return text('need { "name": string } — e.g. {"name":"daily"}\n', 400);
    }
    const routine = routines.find((r) => r.name === name);
    // Drift: a caller outliving the thing it calls. The names are listed so an operator can see whether it is a
    // typo or a stale job without shelling in.
    if (!routine) {
      return text(
        // The name is CLIPPED before it goes back out — the one thing this route echoes. Listing this deployment's
        // own names is deliberate; quoting an unauthenticated caller's 4 KiB of body is not (`refuseNonJsonBody`
        // states the same rule for the same table).
        `no declared work named "${name.slice(0, MAX_ECHOED_NAME)}" (this deployment has: ${routines
          .map((r) => r.name)
          .join(", ")})\n`,
        404,
      );
    }
    return Response.json(await runRoutineByName(agent, routine));
  };
}
