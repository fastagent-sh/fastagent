import { describe, expect, it } from "vitest";
import { bootstrapVerificationToken } from "../src/channels/lark/bootstrap-token.ts";

/** Loopback "tunnel": the public URL IS the local server (tests need no cloudflared). */
const loopback = async (port: number) => ({ url: `http://127.0.0.1:${port}`, close: () => {} });

describe("bootstrapVerificationToken", () => {
  it("captures the token from the url_verification challenge the PATCH triggers (and answers it)", async () => {
    let challengeEcho: unknown;
    const token = await bootstrapVerificationToken({
      appId: "cli_x",
      startTunnel: loopback,
      api: {
        // The platform, miniature: verifying the PATCH means POSTing the challenge at the request URL.
        async updateEventSubscription(_appId, cfg) {
          expect(cfg.requestUrl).toMatch(/\/lark$/);
          const res = await fetch(cfg.requestUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ type: "url_verification", challenge: "chal-1", token: "tok-s3cret" }),
          });
          challengeEcho = await res.json();
        },
      },
    });
    expect(token).toBe("tok-s3cret");
    expect(challengeEcho).toEqual({ challenge: "chal-1" }); // the platform's verification must SUCCEED
  });

  it("the PATCH is the readiness probe: early failures are retried until the edge warms up", async () => {
    let calls = 0;
    const token = await bootstrapVerificationToken({
      appId: "cli_x",
      startTunnel: loopback,
      patchRetryMs: 1,
      api: {
        async updateEventSubscription(_appId, cfg) {
          calls++;
          if (calls < 3) throw new Error("url verification failed — edge not routable yet");
          await fetch(cfg.requestUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ type: "url_verification", challenge: "c", token: "tok-retry" }),
          });
        },
      },
    });
    expect(token).toBe("tok-retry");
    expect(calls).toBe(3);
  });

  it("can classify a definitive PATCH failure as non-retryable (intl config-route 404)", async () => {
    const missing = new Error("config route 404");
    let calls = 0;
    await expect(
      bootstrapVerificationToken({
        appId: "cli_x",
        startTunnel: loopback,
        patchRetryMs: 1,
        shouldRetryPatch: (error) => error !== missing,
        api: {
          async updateEventSubscription() {
            calls++;
            throw missing;
          },
        },
      }),
    ).rejects.toBe(missing);
    expect(calls).toBe(1);
  });

  it("an unreachable-to-US edge does not gate the capture (the platform's path is what matters)", async () => {
    // The "tunnel" advertises a dead URL (our own health probe can never pass), but the platform
    // (fake api) still reaches the local responder — the capture must succeed anyway.
    let realPort = 0;
    const token = await bootstrapVerificationToken({
      appId: "cli_x",
      readyTimeoutMs: 10,
      startTunnel: async (port) => {
        realPort = port;
        return { url: "http://127.0.0.1:9", close: () => {} }; // discard port — routable by nobody
      },
      api: {
        async updateEventSubscription() {
          await fetch(`http://127.0.0.1:${realPort}/lark`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ type: "url_verification", challenge: "c", token: "tok-nofetch" }),
          });
        },
      },
    });
    expect(token).toBe("tok-nofetch");
  });

  it("a challenge that never arrives rejects visibly (no hang, no silent empty token)", async () => {
    await expect(
      bootstrapVerificationToken({
        appId: "cli_x",
        startTunnel: loopback,
        api: { updateEventSubscription: async () => {} },
        timeoutMs: 50,
        patchAttempts: 1,
      }),
    ).rejects.toThrow(/challenge never arrived/);
  });

  it("no tunnel rejects visibly (cloudflared missing is an actionable message, not a hang)", async () => {
    await expect(
      bootstrapVerificationToken({
        appId: "cli_x",
        startTunnel: async () => undefined,
        api: { updateEventSubscription: async () => {} },
      }),
    ).rejects.toThrow(/no tunnel/);
  });
});
