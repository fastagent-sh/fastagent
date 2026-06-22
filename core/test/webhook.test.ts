import { describe, expect, it } from "vitest";
import {
  AgentFailure,
  type Agent,
  type AgentEvent,
  type BackgroundRunner,
  type CollectResult,
  createTrackedBackground,
  createWebhookHandler,
  type WebhookBinding,
} from "../src/index.ts";

/** A faux Agent (contract-only, no engine) that yields the given events — proves the channel
 *  works against any Agent, not just the pi implementation. */
function fauxAgent(events: AgentEvent[]): Agent {
  return {
    async *invoke() {
      for (const e of events) yield e;
    },
  };
}

interface Ev {
  session: string;
  text: string;
}

/** A binding that records deliver/onError calls; parse defaults to reading {session,text}. */
function recordingBinding(parse?: WebhookBinding<Ev>["parse"]): {
  binding: WebhookBinding<Ev>;
  calls: { deliver: CollectResult[]; onError: AgentFailure[]; invocations: Ev[] };
} {
  const calls = { deliver: [] as CollectResult[], onError: [] as AgentFailure[], invocations: [] as Ev[] };
  const binding: WebhookBinding<Ev> = {
    parse: parse ?? (async (req) => (await req.json()) as Ev),
    toInvocation(e) {
      calls.invocations.push(e);
      return { scope: { session: e.session }, prompt: { text: e.text } };
    },
    async deliver(_e, r) {
      calls.deliver.push(r);
    },
    async onError(_e, f) {
      calls.onError.push(f);
    },
  };
  return { binding, calls };
}

/** A background runner that captures the task instead of running it, so a test can assert the
 *  202 is returned BEFORE the turn runs (ACK-early), then run the task explicitly. */
function captureBackground(): { background: BackgroundRunner; run: () => Promise<void> } {
  let task: (() => Promise<void>) | undefined;
  return {
    background: (t) => {
      task = t;
    },
    run: () => {
      if (!task) throw new Error("no background task was scheduled");
      return task();
    },
  };
}

function post(body: unknown): Request {
  return new Request("http://app/hook", { method: "POST", body: JSON.stringify(body) });
}

describe("webhook channel", () => {
  it("rejects non-POST with 405", async () => {
    const { binding } = recordingBinding();
    const handler = createWebhookHandler(fauxAgent([]), binding, captureBackground().background);
    const res = await handler(new Request("http://app/hook", { method: "GET" }));
    expect(res.status).toBe(405);
  });

  it("ACKs 202 and runs the turn AFTER responding (ACK-early)", async () => {
    const agent = fauxAgent([{ type: "text", delta: "looks good" }, { type: "completed" }]);
    const { binding, calls } = recordingBinding();
    const bg = captureBackground();
    const handler = createWebhookHandler(agent, binding, bg.background);

    const res = await handler(post({ session: "pr-1", text: "review" }));
    expect(res.status).toBe(202);
    // The turn has NOT run yet — the binding only ACKed.
    expect(calls.deliver).toHaveLength(0);
    expect(calls.invocations).toEqual([{ session: "pr-1", text: "review" }]);

    await bg.run(); // now the host runs the deferred turn
    expect(calls.deliver).toEqual([{ text: "looks good", data: undefined }]);
    expect(calls.onError).toHaveLength(0);
  });

  it("a turn failure goes to onError out-of-band (not deliver)", async () => {
    const agent = fauxAgent([{ type: "failed", details: "model exploded", retryable: true }]);
    const { binding, calls } = recordingBinding();
    const bg = captureBackground();
    const handler = createWebhookHandler(agent, binding, bg.background);

    const res = await handler(post({ session: "pr-2", text: "review" }));
    expect(res.status).toBe(202);
    await bg.run();

    expect(calls.deliver).toHaveLength(0);
    expect(calls.onError).toHaveLength(1);
    expect(calls.onError[0]).toBeInstanceOf(AgentFailure);
    expect(calls.onError[0]?.details).toBe("model exploded");
    expect(calls.onError[0]?.retryable).toBe(true);
  });

  it("a turn failure with no onError handler surfaces via the runner's error sink (not swallowed)", async () => {
    const agent = fauxAgent([{ type: "failed", details: "model exploded", retryable: true }]);
    const binding: WebhookBinding<Ev> = {
      async parse(req) {
        return (await req.json()) as Ev;
      },
      toInvocation: (e) => ({ scope: { session: e.session }, prompt: { text: e.text } }),
      // no onError — the failure must still be visible
    };
    const errors: unknown[] = [];
    const { background, drain } = createTrackedBackground({ onTaskError: (e) => errors.push(e) });
    const handler = createWebhookHandler(agent, binding, background);

    const res = await handler(post({ session: "pr-4", text: "review" }));
    expect(res.status).toBe(202);
    await drain();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(AgentFailure);
    expect((errors[0] as AgentFailure).details).toBe("model exploded");
  });

  it("parse → null rejects with 401 and never invokes", async () => {
    const { binding, calls } = recordingBinding(async () => null);
    const bg = captureBackground();
    const handler = createWebhookHandler(fauxAgent([]), binding, bg.background);
    const res = await handler(post({ nope: true }));
    expect(res.status).toBe(401);
    expect(calls.invocations).toHaveLength(0);
  });

  it("parse throwing answers 400 (a request fault, before any ACK)", async () => {
    const { binding } = recordingBinding(async () => {
      throw new Error("bad signature");
    });
    const handler = createWebhookHandler(fauxAgent([]), binding, captureBackground().background);
    const res = await handler(post({}));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("bad signature");
  });

  it("delivery is optional: a fat agent that posts via tools needs no deliver/onError", async () => {
    const agent = fauxAgent([{ type: "completed" }]);
    const binding: WebhookBinding<Ev> = {
      async parse(req) {
        return (await req.json()) as Ev;
      },
      toInvocation: (e) => ({ scope: { session: e.session }, prompt: { text: e.text } }),
      // no deliver, no onError — the agent owns its output
    };
    const bg = captureBackground();
    const handler = createWebhookHandler(agent, binding, bg.background);
    const res = await handler(post({ session: "pr-3", text: "review" }));
    expect(res.status).toBe(202);
    await expect(bg.run()).resolves.toBeUndefined(); // no throw with deliver/onError absent
  });
});

describe("createTrackedBackground", () => {
  it("runs tasks and drain() awaits in-flight work", async () => {
    const { background, drain } = createTrackedBackground();
    let done = false;
    background(async () => {
      await new Promise((r) => setTimeout(r, 10));
      done = true;
    });
    expect(done).toBe(false); // not awaited synchronously
    await drain();
    expect(done).toBe(true);
  });

  it("a throwing task is surfaced via onTaskError and does not wedge drain", async () => {
    const errors: unknown[] = [];
    const { background, drain } = createTrackedBackground({ onTaskError: (e) => errors.push(e) });
    background(async () => {
      throw new Error("task boom");
    });
    await expect(drain()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("task boom");
  });

  it("a synchronously-thrown task is captured (not propagated out of background) and tracked", async () => {
    const errors: unknown[] = [];
    const { background, drain } = createTrackedBackground({ onTaskError: (e) => errors.push(e) });
    // A task that throws synchronously (before returning a promise) must not escape background() —
    // otherwise the webhook handler would reject pre-ACK (500) instead of ACKing and tracking it.
    const syncThrow = (() => {
      throw new Error("sync boom");
    }) as () => Promise<void>;
    expect(() => background(syncThrow)).not.toThrow();
    await expect(drain()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("sync boom");
  });
});
