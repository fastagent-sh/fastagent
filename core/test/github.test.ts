import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { type GithubChannelOptions, githubChannel } from "../src/github.ts";
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

/**
 * A faux Agent whose FIRST turn blocks until release(), so the per-session loop stays active while
 * later deliveries arrive — forces the fold path deterministically. Records each turn's text in order.
 */
function gatedAgent() {
  const order: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((r) => {
    release = r;
  });
  let first = true;
  const agent: Agent = {
    async *invoke(_scope: Scope, prompt: Prompt): AsyncIterable<AgentEvent> {
      if (first) {
        first = false;
        await blocked;
      }
      order.push(prompt.text);
      yield { type: "completed" };
    },
  };
  return { agent, order, release: () => release() };
}

/** Sign an arbitrary raw body (for content-type/parse edge cases the JSON `signed()` helper can't make). */
function signedRaw(raw: string, headers: Record<string, string>): Request {
  const sig = `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`;
  return new Request("http://app/webhook", {
    method: "POST",
    body: raw,
    headers: { "x-hub-signature-256": sig, ...headers },
  });
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
  it("depends on no node: builtins (loads on Fetch-only runtimes: Cloudflare/Deno/Bun)", async () => {
    // The channel returns `background` for serverless ctx.waitUntil; a node: import would break
    // module load there. Guard the channel + its body helper. (Its deps are runtime-agnostic too:
    // @octokit/webhooks-methods ships a web build on Web Crypto; @octokit/webhooks-types is types-only.)
    for (const rel of ["../src/channels/github.ts", "../src/channels/body.ts"]) {
      const src = await readFile(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
      expect(src).not.toMatch(/from "node:/);
    }
  });

  it("fails visibly at construction on a missing/empty secret or non-function on", () => {
    const { agent } = recordingAgent();
    const bad = (opts: Partial<GithubChannelOptions>) => () => githubChannel(agent, opts as GithubChannelOptions);
    expect(bad({ secret: undefined, on: () => {} })).toThrow(/secret/);
    expect(bad({ secret: "", on: () => {} })).toThrow(/secret/);
    expect(bad({ secret: SECRET, on: undefined })).toThrow(/on/);
  });

  it("rejects non-POST with 405", async () => {
    const { agent, calls } = recordingAgent();
    const ch = githubChannel(agent, { secret: SECRET, on: () => {} });
    const { response, background } = await ch(new Request("http://app/webhook", { method: "GET" }));
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
    const { response } = await ch(signed(PR_OPENED.body, PR_OPENED.headers, "wrong"));
    expect(response.status).toBe(401);
    expect(routed).toBe(false);
  });

  it("an empty body with a signature header is 401, not 500 (verifier throw handled)", async () => {
    const { agent } = recordingAgent();
    let routed = false;
    const ch = githubChannel(agent, {
      secret: SECRET,
      on: () => {
        routed = true;
      },
    });
    // octokit verify() throws on an empty payload; the channel must fail closed (401), not 500.
    const { response } = await ch(signedRaw("", { "x-github-event": "pull_request", "x-github-delivery": "e1" }));
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
    const { response } = await ch(signed({ zen: "hi" }, { "x-github-event": "ping", "x-github-delivery": "p1" }));
    expect(response.status).toBe(204);
    expect(routed).toBe(false);
  });

  it("a verified body that isn't JSON is 400, no routing", async () => {
    const { agent, calls } = recordingAgent();
    let routed = false;
    const ch = githubChannel(agent, {
      secret: SECRET,
      on: () => {
        routed = true;
      },
    });
    const { response } = await ch(
      signedRaw("not json{", { "x-github-event": "pull_request", "x-github-delivery": "j1" }),
    );
    expect(response.status).toBe(400);
    expect(routed).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("a verified form body without a payload field is 400", async () => {
    const { agent } = recordingAgent();
    let routed = false;
    const ch = githubChannel(agent, {
      secret: SECRET,
      on: () => {
        routed = true;
      },
    });
    const { response } = await ch(
      signedRaw("foo=bar", {
        "content-type": "application/x-www-form-urlencoded",
        "x-github-event": "pull_request",
        "x-github-delivery": "f1",
      }),
    );
    expect(response.status).toBe(400);
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
    const { response, background } = await ch(signed(PR_OPENED.body, PR_OPENED.headers));
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

  it("accepts GitHub's form-urlencoded content type (payload field), routing the same fields", async () => {
    const { agent, calls } = recordingAgent();
    let seen: import("../src/github.ts").GithubDelivery | undefined;
    const ch = githubChannel(agent, {
      secret: SECRET,
      on(d, run) {
        seen = d;
        if (d.event === "pull_request") run({ session: "s", text: "x" });
      },
    });
    const raw = `payload=${encodeURIComponent(JSON.stringify(PR_OPENED.body))}`; // GitHub's form shape
    const sig = `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`; // signed over the raw form body
    const { response, background } = await ch(
      new Request("http://app/webhook", {
        method: "POST",
        body: raw,
        headers: {
          "x-hub-signature-256": sig,
          "content-type": "application/x-www-form-urlencoded",
          "x-github-event": "pull_request",
          "x-github-delivery": "form1",
        },
      }),
    );
    expect(response.status).toBe(202);
    expect(seen).toMatchObject({ event: "pull_request", action: "opened", repo: "o/r", number: 7 });
    await background;
    expect(calls).toEqual([{ session: "s", text: "x" }]);
  });

  it("coalesce (default): deliveries during a run collapse into one re-run of the LATEST", async () => {
    const { agent, order, release } = gatedAgent();
    const ch = githubChannel(agent, {
      secret: SECRET,
      on(d, run) {
        run({ session: "s", text: d.action ?? "" }); // default mode = coalesce
      },
    });
    const r1 = await ch(signed({ action: "a" }, { "x-github-event": "issue_comment", "x-github-delivery": "a" }));
    await new Promise((r) => setTimeout(r, 5)); // loop starts; first turn (a) blocks, gate stays open
    await ch(signed({ action: "b" }, { "x-github-event": "issue_comment", "x-github-delivery": "b" })); // collapsed
    const r3 = await ch(signed({ action: "c" }, { "x-github-event": "issue_comment", "x-github-delivery": "c" })); // latest
    release();
    await Promise.all([r1.background, r3.background]);
    expect(order).toEqual(["a", "c"]); // b folded away; ≤1 in flight, only first + latest ran
  });

  it("mixing concurrency modes on one session warns and never drops the delivery", async () => {
    const { agent, order, release } = gatedAgent();
    const warnings: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((m) => {
      warnings.push(String(m));
    });
    const ch = githubChannel(agent, {
      secret: SECRET,
      on(d, run) {
        run({ session: "s", text: d.action ?? "", concurrency: d.action === "a" ? "coalesce" : "serialize" });
      },
    });
    const r1 = await ch(signed({ action: "a" }, { "x-github-event": "issue_comment", "x-github-delivery": "a" }));
    await new Promise((r) => setTimeout(r, 5)); // coalesce gate active for session s
    const r2 = await ch(signed({ action: "b" }, { "x-github-event": "issue_comment", "x-github-delivery": "b" })); // serialize → mismatch
    release();
    await Promise.all([r1.background, r2.background]);
    expect(warnings.some((w) => /mixes concurrency modes/.test(w))).toBe(true);
    expect(order).toEqual(["a", "b"]); // kept the first mode, ran both — not dropped
    spy.mockRestore();
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
      const { response, background } = await ch(
        signed({ action }, { "x-github-event": "issue_comment", "x-github-delivery": action }),
      );
      expect(response.status).toBe(202);
      if (background) pending.push(background); // only the delivery that STARTS the loop returns one
    }
    await Promise.all(pending);
    expect(calls.map((c) => c.text)).toEqual(["a", "b", "c"]);
  });

  it("a folded same-session delivery still returns a background to pin (not undefined)", async () => {
    // Hold the first turn open so the loop (and its gate) is definitely active when the second
    // delivery arrives — forcing the FOLD path deterministically (not a fresh loop).
    const calls: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    let firstTurn = true;
    const agent: Agent = {
      async *invoke(_scope: Scope, prompt: Prompt): AsyncIterable<AgentEvent> {
        if (firstTurn) {
          firstTurn = false;
          await blocked;
        }
        calls.push(prompt.text);
        yield { type: "completed" };
      },
    };
    const ch = githubChannel(agent, {
      secret: SECRET,
      on(d, run) {
        run({ session: "s", text: d.action ?? "", concurrency: "serialize" });
      },
    });
    const a = await ch(signed({ action: "a" }, { "x-github-event": "issue_comment", "x-github-delivery": "a" }));
    await new Promise((r) => setTimeout(r, 5)); // loop starts; first turn now blocked, gate stays open
    const b = await ch(signed({ action: "b" }, { "x-github-event": "issue_comment", "x-github-delivery": "b" }));
    expect(a.background).toBeDefined();
    expect(b.background).toBeDefined(); // the FOLDED delivery still gets a promise to pin (was undefined before)
    release();
    await Promise.all([a.background, b.background]);
    expect(calls).toEqual(["a", "b"]); // both ran, in arrival order, under the one loop
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
    const { response, background } = await ch(signed(PR_OPENED.body, PR_OPENED.headers));
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
    const { response } = await ch(req);
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
    const fetchP = ch(signed(PR_OPENED.body, PR_OPENED.headers));
    await new Promise((r) => setTimeout(r, 10)); // give macrotasks a chance while on() is pending
    expect(calls).toHaveLength(0); // the turn must NOT have started while on() is pending
    release();
    const { response, background } = await fetchP;
    expect(response.status).toBe(202);
    await background;
    expect(calls).toEqual([{ session: "s", text: "x" }]);
  });

  it("an unknown concurrency mode (e.g. a .js typo) fails visibly, not silently as coalesce", async () => {
    const { agent } = recordingAgent();
    const ch = githubChannel(agent, {
      secret: SECRET,
      on(_d, run) {
        // a .js/.mjs config could pass a typo'd mode; TS would catch it, JS wouldn't
        (run as (t: { session: string; text: string; concurrency: string }) => void)({
          session: "s",
          text: "x",
          concurrency: "serialise",
        });
      },
    });
    // The handler rejects (the host turns that into a 500 + log) — surfaced, not a silent coalesce.
    await expect(ch(signed(PR_OPENED.body, PR_OPENED.headers))).rejects.toThrow(/unknown concurrency/);
  });

  it("an unhandled but verified event acks 202 with no background work", async () => {
    const { agent, calls } = recordingAgent();
    const ch = githubChannel(agent, {
      secret: SECRET,
      on(d, run) {
        if (d.event === "pull_request") run({ session: "x", text: "y" }); // not a pull_request here
      },
    });
    const { response, background } = await ch(
      signed({ action: "labeled" }, { "x-github-event": "label", "x-github-delivery": "d2" }),
    );
    expect(response.status).toBe(202);
    expect(background).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});
