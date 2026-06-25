import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { type GithubEvent, githubChannel } from "../src/github.ts";
import type { Agent, AgentEvent, Prompt, Scope } from "../src/index.ts";

/** A faux Agent that records invocations (contract-only; proves the channel works with any Agent). */
function recordingAgent() {
  const calls: { session: string; text: string }[] = [];
  const agent: Agent = {
    async *invoke(scope: Scope, prompt: Prompt): AsyncIterable<AgentEvent> {
      calls.push({ session: scope.session, text: prompt.text });
      yield { type: "completed" };
    },
  };
  return { agent, calls };
}

/** Let fire-and-forget turns (started after the 202) run to completion before asserting. */
const flush = () => new Promise((r) => setImmediate(r));

const SECRET = "s3cret";

function signed(body: unknown, headers: Record<string, string>, secret = SECRET): Request {
  return signedRaw(JSON.stringify(body), headers, secret);
}

/** Sign an arbitrary raw body (for content-type/parse edge cases the JSON `signed()` helper can't make). */
function signedRaw(raw: string, headers: Record<string, string>, secret = SECRET): Request {
  const sig = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  return new Request("http://app/webhook", {
    method: "POST",
    body: raw,
    headers: { "x-hub-signature-256": sig, ...headers },
  });
}

const PR_OPENED = {
  body: { action: "opened", pull_request: { number: 7 }, repository: { full_name: "o/r" } },
  headers: { "x-github-event": "pull_request", "x-github-delivery": "d1" },
};

describe("github channel", () => {
  it("rejects non-POST with 405", async () => {
    const { agent } = recordingAgent();
    const ch = githubChannel(agent, { secret: SECRET, on: () => [] });
    expect((await ch(new Request("http://app/webhook", { method: "GET" }))).status).toBe(405);
  });

  it("refuses an empty secret at construction (an empty HMAC key accepts forged deliveries)", () => {
    const { agent } = recordingAgent();
    expect(() => githubChannel(agent, { secret: "", on: () => [] })).toThrow(/requires a non-empty secret/);
  });

  it("rejects a bad/missing signature with 401 and never routes", async () => {
    const { agent } = recordingAgent();
    let routed = false;
    const ch = githubChannel(agent, {
      secret: SECRET,
      on: () => {
        routed = true;
        return [];
      },
    });
    expect((await ch(signed(PR_OPENED.body, PR_OPENED.headers, "wrong"))).status).toBe(401);
    expect(routed).toBe(false);
  });

  it("an empty body with a signature header is 401, not 500 (verifier throw handled)", async () => {
    const { agent } = recordingAgent();
    const ch = githubChannel(agent, { secret: SECRET, on: () => [] });
    // octokit verify() throws on an empty payload; the channel must fail closed (401), not 500.
    expect((await ch(signedRaw("", { "x-github-event": "pull_request", "x-github-delivery": "e1" }))).status).toBe(401);
  });

  it("acks a verified ping with 204, no routing", async () => {
    const { agent } = recordingAgent();
    let routed = false;
    const ch = githubChannel(agent, {
      secret: SECRET,
      on: () => {
        routed = true;
        return [];
      },
    });
    expect((await ch(signed({ zen: "hi" }, { "x-github-event": "ping", "x-github-delivery": "p1" }))).status).toBe(204);
    expect(routed).toBe(false);
  });

  it("a verified body that isn't JSON is 400", async () => {
    const { agent } = recordingAgent();
    const ch = githubChannel(agent, { secret: SECRET, on: () => [] });
    expect(
      (await ch(signedRaw("not json{", { "x-github-event": "pull_request", "x-github-delivery": "j1" }))).status,
    ).toBe(400);
  });

  it("rejects an oversized body with 413 before verifying (DoS guard)", async () => {
    const { agent } = recordingAgent();
    const big = "x".repeat((25 << 20) + 1); // just over the 25 MiB cap
    const ch = githubChannel(agent, { secret: SECRET, on: () => [] });
    const res = await ch(
      new Request("http://app/webhook", {
        method: "POST",
        body: big,
        headers: { "x-github-event": "pull_request", "x-github-delivery": "big" },
      }),
    );
    expect(res.status).toBe(413); // rejected before HMAC/JSON
  });

  it("routes a verified PR event: pre-extracts header fields + typed payload, 202, agent invoked", async () => {
    const { agent, calls } = recordingAgent();
    let seen: GithubEvent | undefined;
    const ch = githubChannel(agent, {
      secret: SECRET,
      on(event) {
        seen = event;
        return event.event === "pull_request" && event.action === "opened"
          ? [{ session: "pr-o/r#7", text: "Review #7" }]
          : [];
      },
    });
    const res = await ch(signed(PR_OPENED.body, PR_OPENED.headers));
    expect(res.status).toBe(202);
    expect(seen).toMatchObject({ event: "pull_request", action: "opened", deliveryId: "d1" });
    expect((seen?.payload as { repository?: { full_name?: string } }).repository?.full_name).toBe("o/r");

    await flush(); // the fire-and-forget turn runs (202 returns without awaiting it to completion)
    expect(calls).toEqual([{ session: "pr-o/r#7", text: "Review #7" }]);
  });

  it("accepts GitHub's form-urlencoded content type (payload field) and routes the same", async () => {
    const { agent, calls } = recordingAgent();
    const ch = githubChannel(agent, {
      secret: SECRET,
      on: (e) => (e.event === "pull_request" ? [{ session: "s", text: "x" }] : []),
    });
    const raw = `payload=${encodeURIComponent(JSON.stringify(PR_OPENED.body))}`; // GitHub's form shape, signed over the raw form body
    const res = await ch(
      signedRaw(raw, {
        "content-type": "application/x-www-form-urlencoded",
        "x-github-event": "pull_request",
        "x-github-delivery": "form1",
      }),
    );
    expect(res.status).toBe(202);
    await flush();
    expect(calls).toEqual([{ session: "s", text: "x" }]);
  });

  it("a verified form body without a payload field is 400", async () => {
    const { agent } = recordingAgent();
    const ch = githubChannel(agent, { secret: SECRET, on: () => [] });
    const res = await ch(
      signedRaw("foo=bar", {
        "content-type": "application/x-www-form-urlencoded",
        "x-github-event": "pull_request",
        "x-github-delivery": "f1",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("an event the routing ignores acks 202 and never invokes", async () => {
    const { agent, calls } = recordingAgent();
    const ch = githubChannel(agent, {
      secret: SECRET,
      on: (e) => (e.event === "pull_request" ? [{ session: "x", text: "y" }] : []), // not pull_request here
    });
    const res = await ch(signed({ action: "labeled" }, { "x-github-event": "label", "x-github-delivery": "d2" }));
    expect(res.status).toBe(202);
    await flush();
    expect(calls).toHaveLength(0);
  });

  it("ACK-early: returns 202 BEFORE the turn completes (fire-and-forget)", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    const completed: string[] = [];
    const agent: Agent = {
      async *invoke(scope: Scope, _prompt: Prompt): AsyncIterable<AgentEvent> {
        await blocked; // hold the turn open
        completed.push(scope.session);
        yield { type: "completed" };
      },
    };
    const ch = githubChannel(agent, {
      secret: SECRET,
      on: (e) => (e.event === "pull_request" ? [{ session: "s", text: "x" }] : []),
    });
    // If the channel awaited the turn to completion, this await would hang (the turn is blocked).
    const res = await ch(signed(PR_OPENED.body, PR_OPENED.headers));
    expect(res.status).toBe(202);
    expect(completed).toHaveLength(0); // 202 returned while the turn is still in flight
    release();
    await flush();
    expect(completed).toEqual(["s"]); // it does run to completion afterward
  });

  it("a turn that fails after the 202 is caught + logged, not an unhandled rejection", async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((m) => {
      errors.push(String(m));
    });
    const agent: Agent = {
      async *invoke(): AsyncIterable<AgentEvent> {
        yield { type: "failed", details: "boom", retryable: false }; // collect throws AgentFailure
      },
    };
    const ch = githubChannel(agent, {
      secret: SECRET,
      on: (e) => (e.event === "pull_request" ? [{ session: "s", text: "x" }] : []),
    });
    expect((await ch(signed(PR_OPENED.body, PR_OPENED.headers))).status).toBe(202);
    await flush();
    // The lone failure sink (.catch) ran: logged, and (since it ran) not an unhandled rejection.
    expect(errors.some((e) => /turn failed for s/.test(e) && /boom/.test(e))).toBe(true);
    spy.mockRestore();
  });
});
