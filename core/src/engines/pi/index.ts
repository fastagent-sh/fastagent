/**
 * pi reference implementation: fans pi AgentHarness's two ports
 * (subscribe event side-channel + prompt final value) into SPEC's single event stream.
 *
 * createAgent returns an object that **implements the Agent contract** (composition,
 * not inheritance): it has-a harness + translate + queue, composed into invoke.
 *
 * Concurrency: at most one in-flight turn per session. Contention = fail-fast: the
 * second invoke immediately yields `failed{retryable}` ("session busy"), leaving
 * dedupe/queueing/steering UX decisions to the channel.
 * Each invoke spins up a fresh harness bound to the session, discarded after use
 * (stateless multi-session). Session construction and env/model/tools injection all
 * live in the caller-provided buildHarness factory.
 */
import type { ImageContent } from "@earendil-works/pi-ai";
import type { Agent, AgentEvent, Prompt, Scope } from "../../agent.ts";
import type { BuildHarness } from "./harness.ts";
import { type Lease, inProcessLease } from "./lease.ts";
import { EventQueue } from "./queue.ts";
import { errorToTerminal, toAgentEvent, toTerminal } from "./translate.ts";

export interface CreateAgentOptions {
  buildHarness: BuildHarness;
  /** Single-writer lease. Defaults to the in-process per-session fail-fast lease. */
  lease?: Lease;
}

export function createAgent(options: CreateAgentOptions): Agent {
  const { buildHarness, lease = inProcessLease() } = options;

  async function* invoke(scope: Scope, prompt: Prompt): AsyncIterable<AgentEvent> {
    // Fail-fast single writer: if the session already has an in-flight turn, report
    // busy immediately — no queueing. tryAcquire is synchronous, so no await sits
    // between acquiring and entering try: cancellation anywhere still releases.
    const release = lease.tryAcquire(scope.session);
    if (!release) {
      yield {
        type: "failed",
        details: "session busy: a turn is already in flight for this session",
        retryable: true,
      };
      return;
    }
    try {
      let harness;
      try {
        harness = await buildHarness(scope.session);
      } catch (error) {
        // Setup failures (session open / auth / …) MUST also surface as a failed
        // event, never as a throw.
        yield errorToTerminal(error);
        return;
      }

      const queue = new EventQueue<AgentEvent>();
      const unsub = harness.subscribe((pe) => {
        const event = toAgentEvent(pe);
        if (event) queue.push(event);
      });
      try {
        const run = harness.prompt(prompt.text, toPromptOptions(prompt));
        // Yield text / tool_* as they happen, until run settles and the buffer drains.
        yield* queue.drainUntil(run);
        // Terminal is decided by the resolved message's stopReason; catch only
        // covers genuine throws.
        let terminal: AgentEvent;
        try {
          terminal = toTerminal(await run);
        } catch (error) {
          terminal = errorToTerminal(error);
        }
        yield terminal;
      } finally {
        // Both cancel (generator return → finally) and normal completion pass here.
        // Cleanup MUST NOT throw: an abort()/unsub() exception after the terminal
        // was yielded would make iteration throw, polluting an already-closed
        // event stream (violating SPEC MUST 2 / MUST 3).
        try {
          unsub();
        } catch {
          // ignore
        }
        try {
          await harness.abort();
        } catch {
          // ignore
        }
      }
    } finally {
      release(); // release after cleanup so the next invoke for this session can enter
    }
  }

  return { invoke };
}

function toPromptOptions(prompt: Prompt): { images?: ImageContent[] } | undefined {
  if (!prompt.images || prompt.images.length === 0) return undefined;
  return {
    images: prompt.images.map((img) => ({
      type: "image",
      data: img.data,
      mimeType: img.mimeType,
    })),
  };
}
