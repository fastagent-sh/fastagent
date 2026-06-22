/**
 * GitHub webhook → one review turn (the N-side glue for this agent).
 *
 * Verifies the HMAC signature, then classifies the delivery into a WebhookOutcome:
 *   - a reviewable pull_request event (opened/synchronize/reopened/ready_for_review) → invoke;
 *   - everything else (ping, other events, other actions) → ignore (200, so GitHub doesn't retry);
 *   - a bad/missing signature → reject (401).
 *
 * The agent posts its own review via `gh` (a fat agent), so this binding delivers nothing; a turn
 * that crashes before posting surfaces through the background runner's error sink.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { WebhookBinding } from "@kid7st/fastagent";

interface PrEvent {
  /** "owner/repo". */
  repo: string;
  number: number;
}

const REVIEWABLE = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);

/** Constant-time compare of GitHub's X-Hub-Signature-256 against the body HMAC. */
function verify(raw: string, signature: string | null, secret: string): boolean {
  if (!signature) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const githubBinding: WebhookBinding<PrEvent> = {
  async parse(req) {
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) throw new Error("GITHUB_WEBHOOK_SECRET is not set"); // misconfig → 400, fail visibly
    const raw = await req.text();
    if (!verify(raw, req.headers.get("x-hub-signature-256"), secret)) {
      return { action: "reject", status: 401 };
    }
    const event = req.headers.get("x-github-event");
    const payload = JSON.parse(raw) as {
      action?: string;
      number?: number;
      pull_request?: { number?: number };
      repository?: { full_name?: string };
    };
    // Only reviewable pull_request events run the agent; ACK everything else (ping, labels,
    // comments, other repos' event types) with 200 — the WebhookOutcome "ignore" path — so GitHub
    // marks the delivery succeeded instead of retrying it.
    if (event !== "pull_request" || !payload.action || !REVIEWABLE.has(payload.action)) {
      return { action: "ignore" };
    }
    const repo = payload.repository?.full_name;
    const number = payload.pull_request?.number ?? payload.number;
    if (typeof repo !== "string" || typeof number !== "number") return { action: "ignore" };
    return { action: "invoke", event: { repo, number } };
  },

  toInvocation(e) {
    return {
      // Same PR re-pushed → same session, so the next review sees the prior one in context.
      scope: { session: `pr-${e.repo}#${e.number}` },
      prompt: { text: `Review pull request #${e.number} in ${e.repo}. Post your review with gh.` },
    };
  },

  // No deliver/onError: the agent owns its output (it posts via gh). A pre-post crash is surfaced
  // by the background runner's onTaskError sink (logs); add onError here to post a "review failed"
  // comment if you want user-facing failure delivery.
};
