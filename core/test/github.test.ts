import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { githubChannel } from "../src/github.ts";
import type { Agent, AgentEvent, Prompt, Scope } from "../src/index.ts";

/** A faux Agent that records invocations (contract-only; proves the channel works with any Agent). */
function recordingAgent() {
  const calls: { session: string; text: string }[] = [];
  const agent: Agent = {
    // Fully synchronous on purpose: if the channel still ACKs early with this, the macrotask defer
    // holds regardless of what a real invoke() does synchronously (lease/harness/auth setup).
    async *invoke(scope: Scope, prompt: Prompt): AsyncIterable<AgentEvent> {
      calls.push({ session: scope.session, text: prompt.text });
      yield { type: "completed" };
    },
  };
  return { agent, calls };
}

const SECRET = "s3cret";

function signed(body: unknown, headers: Record<string, string>, secret = SECRET): Request {
  const raw = JSON.stringify(body);
  const sig = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  return new Request("http://app/webhook", {
    method: "POST",
    body: raw,
    headers: { "x-hub-signature-256": sig, ...headers },
  });
}

const PR_OPENED = {
  body: {
    action: "opened",
    pull_request: { number: 7 },
    repository: { full_name: "o/r" },
    sender: { login: "alice" },
    installation: { id: 42 },
  },
  headers: { "x-github-event": "pull_request", "x-github-delivery": "d1" },
};

describe("github channel", () => {
  it("rejects non-POST with 405", async () => {
    const { agent, calls } = recordingAgent();
    const ch = githubChannel(agent, { secret: SECRET, on: () => {} });
    const { response, background } = await ch.fetch(new Request("http://app/webhook", { method: "GET" }));
    expect(response.status).toBe(405);
    expect(background).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("rejects a bad/missing signature with 401 and never routes", async () => {
    const { agent } = recordingAgent();
    let routed = false;
    const ch = githubChannel(agent, {
      secret: SECRET,
      on: () => {
        routed = true;
      },
    });
    // valid body, but signed with the wrong secret
    const { response } = await ch.fetch(signed(PR_OPENED.body, PR_OPENED.headers, "wrong"));
    expect(response.status).toBe(401);
    expect(routed).toBe(false);
  });

  it("acks a verified ping with 204, no routing", async () => {
    const { agent } = recordingAgent();
    let routed = false;
    const ch = githubChannel(agent, {
      secret: SECRET,
      on: () => {
        routed = true;
      },
    });
    const { response } = await ch.fetch(signed({ zen: "hi" }, { "x-github-event": "ping", "x-github-delivery": "p1" }));
    expect(response.status).toBe(204);
    expect(routed).toBe(false);
  });

  it("routes a verified PR event: 202, pre-extracted fields, agent invoked after drain", async () => {
    const { agent, calls } = recordingAgent();
    let seen: import("../src/github.ts").GithubDelivery | undefined;
    const ch = githubChannel(agent, {
      secret: SECRET,
      on(d, run) {
        seen = d;
        if (d.event === "pull_request" && d.action === "opened") {
          run({ session: `pr-${d.repo}#${d.number}`, text: `Review #${d.number} in ${d.repo}` });
        }
      },
    });
    const { response, background } = await ch.fetch(signed(PR_OPENED.body, PR_OPENED.headers));
    expect(response.status).toBe(202);
    expect(seen).toMatchObject({
      event: "pull_request",
      action: "opened",
      deliveryId: "d1",
      repo: "o/r",
      number: 7,
      sender: "alice",
      installationId: 42,
    });
    expect(calls).toHaveLength(0); // ACK-early: not invoked synchronously

    await background; // the host keeps this alive (here we just await it)
    expect(calls).toEqual([{ session: "pr-o/r#7", text: "Review #7 in o/r" }]);
  });

  it("serialize: every same-session delivery runs in arrival order, none dropped", async () => {
    const { agent, calls } = recordingAgent();
    const ch = githubChannel(agent, {
      secret: SECRET,
      on(d, run) {
        run({ session: "s", text: d.action ?? "", concurrency: "serialize" });
      },
    });
    const pending: Promise<unknown>[] = [];
    for (const action of ["a", "b", "c"]) {
      const { response, background } = await ch.fetch(
        signed({ action }, { "x-github-event": "issue_comment", "x-github-delivery": action }),
      );
      expect(response.status).toBe(202);
      if (background) pending.push(background); // only the delivery that STARTS the loop returns one
    }
    await Promise.all(pending);
    expect(calls.map((c) => c.text)).toEqual(["a", "b", "c"]);
  });

  it("declares post-ACK work as `background` for the host to satisfy (serverless: ctx.waitUntil)", async () => {
    const { agent, calls } = recordingAgent();
    const ch = githubChannel(agent, {
      secret: SECRET,
      on(d, run) {
        if (d.event === "pull_request") run({ session: "s", text: "x" });
      },
    });
    // The channel only DECLARES the work; a serverless host satisfies it with ctx.waitUntil(background).
    const { response, background } = await ch.fetch(signed(PR_OPENED.body, PR_OPENED.headers));
    expect(response.status).toBe(202);
    expect(background).toBeDefined();
    expect(calls).toHaveLength(0); // ACK-early: nothing run before the host keeps it alive
    await background; // = ctx.waitUntil(background) on the platform
    expect(calls).toEqual([{ session: "s", text: "x" }]);
  });

  it("rejects an oversized body with 413 before verifying (DoS guard)", async () => {
    const { agent, calls } = recordingAgent();
    let routed = false;
    const ch = githubChannel(agent, {
      secret: SECRET,
      on: () => {
        routed = true;
      },
    });
    const big = "x".repeat((25 << 20) + 1); // just over the 25 MiB cap
    const req = new Request("http://app/webhook", {
      method: "POST",
      body: big,
      headers: { "x-github-event": "pull_request", "x-github-delivery": "big" },
    });
    const { response } = await ch.fetch(req);
    expect(response.status).toBe(413); // rejected before HMAC/JSON
    expect(routed).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("ACK-early holds for async routing: no turn starts until on() resolves", async () => {
    const { agent, calls } = recordingAgent(); // synchronous agent: if a turn starts, it records at once
    let release!: () => void;
    const slow = new Promise<void>((r) => {
      release = r;
    });
    const ch = githubChannel(agent, {
      secret: SECRET,
      async on(d, run) {
        if (d.event === "pull_request") run({ session: "s", text: "x" }); // route first
        await slow; // then a slow async step (telemetry / a lookup) — on() stays pending
      },
    });
    const fetchP = ch.fetch(signed(PR_OPENED.body, PR_OPENED.headers));
    await new Promise((r) => setTimeout(r, 10)); // give macrotasks a chance while on() is pending
    expect(calls).toHaveLength(0); // the turn must NOT have started while on() is pending
    release();
    const { response, background } = await fetchP;
    expect(response.status).toBe(202);
    await background;
    expect(calls).toEqual([{ session: "s", text: "x" }]);
  });

  it("an unhandled but verified event acks 202 with no background work", async () => {
    const { agent, calls } = recordingAgent();
    const ch = githubChannel(agent, {
      secret: SECRET,
      on(d, run) {
        if (d.event === "pull_request") run({ session: "x", text: "y" }); // not a pull_request here
      },
    });
    const { response, background } = await ch.fetch(
      signed({ action: "labeled" }, { "x-github-event": "label", "x-github-delivery": "d2" }),
    );
    expect(response.status).toBe(202);
    expect(background).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});
