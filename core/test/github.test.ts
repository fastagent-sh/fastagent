import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Agent, AgentEvent, Prompt, Scope } from "../src/index.ts";
import { githubChannel } from "../src/github.ts";

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
    const res = await ch.fetch(new Request("http://app/webhook", { method: "GET" }));
    expect(res.status).toBe(405);
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
    const res = await ch.fetch(signed(PR_OPENED.body, PR_OPENED.headers, "wrong"));
    expect(res.status).toBe(401);
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
    const res = await ch.fetch(signed({ zen: "hi" }, { "x-github-event": "ping", "x-github-delivery": "p1" }));
    expect(res.status).toBe(204);
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

    const res = await ch.fetch(signed(PR_OPENED.body, PR_OPENED.headers));
    expect(res.status).toBe(202);
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

    await ch.drain();
    expect(calls).toEqual([{ session: "pr-o/r#7", text: "Review #7 in o/r" }]);
  });

  it("an unhandled but verified event acks 202 and never invokes", async () => {
    const { agent, calls } = recordingAgent();
    const ch = githubChannel(agent, {
      secret: SECRET,
      on(d, run) {
        if (d.event === "pull_request") run({ session: "x", text: "y" }); // not a pull_request here
      },
    });
    const res = await ch.fetch(signed({ action: "labeled" }, { "x-github-event": "label", "x-github-delivery": "d2" }));
    expect(res.status).toBe(202);
    await ch.drain();
    expect(calls).toHaveLength(0);
  });
});
