/**
 * The one retry loop every webhook registrar spends its budget through. It was four copies until this
 * file existed — same counting, same "attempt i/N" announcement, same wait — differing only in the
 * predicate and in what a final failure means, which is what stayed with the platforms.
 */
import { describe, expect, it, vi } from "vitest";
import { DEPLOY_REGISTRATION_ATTEMPTS, REGISTRATION_RETRY_MS, retryWhile } from "../src/channels/registration.ts";

const retryable = (error: unknown): boolean => String(error).includes("not yet");

describe("retryWhile", () => {
  it("repeats a retryable failure until the call succeeds", async () => {
    let calls = 0;
    const result = await retryWhile(
      async () => {
        if (++calls < 3) throw new Error("not yet");
        return "ok";
      },
      retryable,
      { retryMs: 1 },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("throws a non-retryable failure on the first attempt, without waiting or announcing", async () => {
    const onRetry = vi.fn();
    let calls = 0;
    await expect(
      retryWhile(
        async () => {
          calls++;
          throw new Error("bad credentials");
        },
        retryable,
        { retryMs: 60_000, onRetry }, // a wait this long would hang the test if it were reached
      ),
    ).rejects.toThrow(/bad credentials/);
    expect(calls).toBe(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("throws the LAST error when the budget runs out — the caller reports what it was still failing on", async () => {
    let calls = 0;
    await expect(
      retryWhile(
        async () => {
          throw new Error(`not yet #${++calls}`);
        },
        retryable,
        { attempts: 3, retryMs: 1 },
      ),
    ).rejects.toThrow(/not yet #3/);
    expect(calls).toBe(3);
  });

  it("announces BEFORE the wait — a caller may release state there that must not span the sleep", async () => {
    // `add slack` drops its duplicate-guard marker in onRetry: an unverifiable URL created no app, and
    // a Ctrl-C during the wait must not leave the next run refusing to create one.
    vi.useFakeTimers();
    try {
      const onRetry = vi.fn();
      const pending = retryWhile(
        async () => {
          throw new Error("not yet");
        },
        retryable,
        { attempts: 2, retryMs: 10_000, onRetry },
      );
      pending.catch(() => {}); // the rejection is asserted below; this keeps it from going unhandled
      await vi.advanceTimersByTimeAsync(0); // settle the first attempt without spending any of the wait
      expect(onRetry).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(pending).rejects.toThrow(/not yet/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("announces every wait and only waits between attempts", async () => {
    // A silent minute reads as a hang, and an announcement after the last attempt would promise a
    // retry that never comes.
    const announced: string[] = [];
    await expect(
      retryWhile(
        async () => {
          throw new Error("not yet");
        },
        retryable,
        {
          attempts: 3,
          retryMs: 1,
          onRetry: ({ attempt, attempts, error }) => announced.push(`${attempt}/${attempts} ${String(error)}`),
        },
      ),
    ).rejects.toThrow();
    expect(announced).toEqual(["1/3 Error: not yet", "2/3 Error: not yet"]);
  });
});

describe("registration budgets", () => {
  it("the deploy budget outlasts what a host takes to start serving", () => {
    // railway-deploy.live.test.ts allows a real deployment 180s to answer /health, because
    // `railway up --ci` returns when the BUILD ends. Registration failure gates the deploy, so a
    // budget shorter than that reports a working deployment as one to re-run.
    expect(DEPLOY_REGISTRATION_ATTEMPTS * REGISTRATION_RETRY_MS).toBeGreaterThanOrEqual(180_000);
  });
});
