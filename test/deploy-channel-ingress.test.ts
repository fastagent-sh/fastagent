import { describe, expect, it, vi } from "vitest";
import { declaredChannels } from "../src/channels/discover.ts";
import { webhookKinds } from "../src/channels/webhooks.ts";
import type { RegistrationOutcome } from "../src/channels/registration.ts";
import { planAgentcoreDeploy } from "../src/deploy/agentcore/plan.ts";
import {
  confirmWebhooks,
  loginGate,
  publicHealthGate,
  registerWebhooks,
  webhookPaths,
  webhookRunbook,
} from "../src/deploy/channel-ingress.ts";
import { planFlyDeploy } from "../src/deploy/fly/plan.ts";
import { planRailwayDeploy } from "../src/deploy/railway/plan.ts";

const registered = (): Promise<RegistrationOutcome> => Promise.resolve("registered");
const webhook = (...names: string[]) => declaredChannels(names);
const longConnection = (...names: string[]) => declaredChannels(names, "long-connection");

describe("deploy/channel-ingress: the readiness floor before registration", () => {
  it("is not asked when there is no webhook to point", async () => {
    // A schedules-only or long-connection deployment needs no inbound reachability, so demanding it would
    // invent a failure for a deploy run from a network that cannot reach the platform's edge.
    const probe = vi.fn(async () => false);
    for (const channels of [[], longConnection("telegram"), webhook("discord")]) {
      expect(await publicHealthGate({ baseUrl: "https://x", channels, log: () => {}, inspectHint: "h", probe })).toBe(
        undefined,
      );
    }
    expect(probe).not.toHaveBeenCalled();
  });

  it("gates on the URL and hands over the manual route, since only registration is left undone", async () => {
    const logs: string[] = [];
    const gate = await publicHealthGate({
      baseUrl: "https://x",
      channels: webhook("telegram"),
      log: (m) => logs.push(m),
      inspectHint: "the app itself deployed — inspect the logs",
      probe: async () => false,
    });
    expect(gate).toContain("https://x/health");
    expect(gate).toContain("the app itself deployed"); // the host's own words, not this module's
    expect(logs.join("\n")).toContain("url=https://x/telegram"); // the runbook line to do it by hand
  });

  it("when a login follows, is asked without a webhook, and the manual route starts with the login", async () => {
    const login = "fastagent login openai-codex --deployment fly";
    const probe = vi.fn(async () => false);
    const alone = await publicHealthGate({
      baseUrl: "https://x",
      channels: [],
      log: () => {},
      inspectHint: "h",
      login,
      probe,
    });
    expect(probe).toHaveBeenCalled(); // the login needs the box ready: the CLI its first boot installs
    expect(alone).toContain(`Once it answers, log it in: ${login}`);
    expect(alone).not.toMatch(/lines above/); // there are none

    const logs: string[] = [];
    const withWebhook = await publicHealthGate({
      baseUrl: "https://x",
      channels: webhook("telegram"),
      log: (m) => logs.push(m),
      inspectHint: "h",
      login,
      probe,
    });
    expect(withWebhook).toMatch(/use the lines above/);
    const loginAt = logs.findIndex((l) => l.includes(login));
    expect(loginAt).toBeGreaterThanOrEqual(0);
    // Before any channel is pointed at the box.
    expect(logs.findIndex((l) => l.includes("url=https://x/telegram"))).toBeGreaterThan(loginAt);
  });
});

describe("deploy/channel-ingress: a login that did not happen", () => {
  const notLoggedIn = "not logged in: … — run `fastagent login openai-codex --deployment fly` in a terminal";
  const afterLogin = "re-run the deploy";

  it("with no webhook to point, is the login's own refusal and nothing else", () => {
    const logs: string[] = [];
    const gate = loginGate({ notLoggedIn, channels: longConnection("feishu"), log: (m) => logs.push(m), afterLogin });
    expect(gate).toBe(notLoggedIn);
    expect(logs).toEqual([]);
  });

  it("with one, says this deploy and the login confirm none, and what this host does once logged in", () => {
    const logs: string[] = [];
    const gate = loginGate({ notLoggedIn, channels: webhook("telegram"), log: (m) => logs.push(m), afterLogin });
    expect(gate).toBe(
      `${notLoggedIn}. This deploy confirmed no webhook, and logging in confirms none; any already pointed here, ` +
        `by the box itself or by an earlier deploy, still delivers, and every message it brings fails until the box ` +
        `is logged in. Once it is, ` +
        afterLogin,
    );
    expect(logs).toEqual([]); // no URL yet: nothing to point by hand
  });

  it("with the URL known, prints the lines to point the channels by hand", () => {
    const logs: string[] = [];
    const gate = loginGate({
      notLoggedIn,
      channels: webhook("telegram"),
      log: (m) => logs.push(m),
      afterLogin,
      baseUrl: "https://x",
    });
    expect(gate).toMatch(/The lines above point the channels by hand\.$/);
    expect(logs.join("\n")).toContain("url=https://x/telegram");
  });
});

describe("deploy/channel-ingress: which channels have a webhook", () => {
  it("answers in declaration order, whatever order the channels arrive in", () => {
    expect(webhookKinds(webhook("lark", "slack", "telegram"))).toEqual(["telegram", "slack", "lark"]);
    expect(webhookPaths(webhook("slack", "telegram"))).toEqual(["/telegram", "/slack"]);
  });

  it("EVERY long-connection channel is excluded, not just feishu/lark", () => {
    // The rule used to be spelled per host and only reached the feishu/lark branches. A long-connection
    // telegram is the case that made it expensive: setting a webhook makes getUpdates return 409, so a
    // runbook that prints setWebhook stops the channel the operator just deployed.
    expect(webhookKinds([...longConnection("telegram"), ...webhook("slack")])).toEqual(["slack"]);
    expect(webhookRunbook("https://x", longConnection("telegram"))).toEqual([]);
    expect(webhookPaths(longConnection("telegram", "slack"))).toEqual([]);
  });

  it("skips a custom channel: this tool cannot instruct anyone about a URL it does not know", () => {
    expect(webhookKinds(webhook("discord", "telegram"))).toEqual(["telegram"]);
  });

  it("does not register a long-connection channel either — the connection IS the ingress", async () => {
    const telegram = vi.fn(registered);
    const gate = await registerWebhooks({
      baseUrl: "https://x",
      channels: longConnection("telegram"),
      registrars: { telegram },
      log: () => {},
      retryHint: "re-run",
    });
    expect(telegram).not.toHaveBeenCalled();
    expect(gate).toBeUndefined();
  });

  it("a channel with no registrar wired reports manual with the operator's instruction", async () => {
    const said: string[] = [];
    const gate = await registerWebhooks({
      baseUrl: "https://x",
      // slack's and the feishu clouds' registrars are not wired here.
      channels: webhook("slack", "feishu", "lark"),
      registrars: { telegram: vi.fn(registered) },
      log: (m) => said.push(m),
      retryHint: "re-run",
    });
    expect(said.filter((m) => m.includes("https://x"))).toHaveLength(3);
    expect(said.join("\n")).toContain("Event Subscriptions");
    expect(said.join("\n")).toContain("https://x/feishu");
    expect(said.join("\n")).toContain("https://x/lark");
    // manual never gates: a re-run cannot clear it, and an unclearable gate spins a coding agent.
    expect(gate).toBeUndefined();
  });

  it("a manual step also goes to the person who reads no log, whether a registrar or no registrar left it", async () => {
    const left: string[] = [];
    const gate = await registerWebhooks({
      baseUrl: "https://x",
      channels: webhook("telegram", "lark"),
      // Lark's config API answers 404, as it does: the registrar can only say "manual".
      registrars: {
        telegram: vi.fn(registered),
        feishu: vi.fn(async () => "manual" as const),
        leave: (s) => left.push(s),
      },
      log: () => {},
      retryHint: "re-run",
    });
    expect(gate).toBeUndefined();
    expect(left).toEqual([expect.stringMatching(/^lark: set the event Request URL .* → https:\/\/x\/lark /)]);

    const unwired: string[] = [];
    await registerWebhooks({
      baseUrl: "https://x",
      channels: webhook("slack"),
      registrars: { telegram: vi.fn(registered), leave: (s) => unwired.push(s) },
      log: () => {},
      retryHint: "re-run",
    });
    expect(unwired).toEqual(["slack: set Event Subscriptions → Request URL → https://x/slack"]);
  });

  it("a failed registrar gates, and one failure does not skip the rest", async () => {
    const feishu = vi.fn(async (): Promise<RegistrationOutcome> => "registered");
    const gate = await registerWebhooks({
      baseUrl: "https://x",
      channels: webhook("telegram", "slack", "feishu", "lark"),
      registrars: { telegram: async () => "failed", feishu },
      log: () => {},
      retryHint: "re-run with --into-linked",
    });
    // Each kind reaches its own seam, with the kind it belongs to.
    expect(feishu.mock.calls).toEqual([
      ["https://x", "feishu"],
      ["https://x", "lark"],
    ]);
    expect(gate).toContain("telegram");
    expect(gate).toContain("re-run with --into-linked");
  });

  it("names only the production apps it registered and says when webhook delivery starts", async () => {
    const said: string[] = [];
    await registerWebhooks({
      baseUrl: "https://x",
      channels: webhook("telegram", "slack", "feishu", "lark"),
      registrars: { telegram: async () => "failed", feishu: registered },
      log: (line) => said.push(line),
      retryHint: "re-run",
    });
    const moved = said.filter((line) => line.includes("delivers to this deployment"));
    expect(moved).toEqual([
      "the selected production feishu app delivers to this deployment once its published version is in webhook mode " +
        "(after a first deploy, publish the version it opened)",
      expect.stringContaining("selected production lark app delivers to this deployment"),
    ]);
  });
});

describe("deploy/channel-ingress: what a box that points its own channels made of them", () => {
  it("reads the box's /health until nothing is pending, then gates on what it reports", async () => {
    const reads = [
      undefined, // not answering yet
      [{ channel: "telegram", outcome: "pending" as const }],
      [
        { channel: "telegram", outcome: "registered" as const },
        { channel: "lark", outcome: "manual" as const },
      ],
    ];
    const probe = vi.fn(async (_url: string) => reads.shift() ?? []);
    const logs: string[] = [];
    const left: string[] = [];
    const gate = await confirmWebhooks({
      baseUrl: "https://x",
      // The platforms reach it at another URL (a custom domain): every step names that one, never the host's.
      publicUrl: "https://agent.acme.com",
      channels: webhook("telegram", "lark"),
      registrars: { leave: (step) => left.push(step) },
      log: (m) => logs.push(m),
      retryHint: "re-run",
      probe,
      intervalMs: 0,
    });
    expect(gate).toBeUndefined();
    expect(probe).toHaveBeenCalledWith("https://x/health");
    expect(probe).toHaveBeenCalledTimes(3);
    expect(logs.join("\n")).toContain("the selected production telegram app now delivers to this deployment");
    // The step a person acts on is said here, and handed to a coding agent's user; why is in the box's log.
    expect(left).toEqual([
      expect.stringContaining(
        "lark: set the event Request URL in the developer console (Events & Callbacks) → https://agent.acme.com/lark",
      ),
    ]);
  });

  it("a channel the box reports failed, or never ends, gates the run", async () => {
    const failed = await confirmWebhooks({
      baseUrl: "https://x",
      publicUrl: "https://x",
      channels: webhook("telegram"),
      registrars: {},
      log: () => {},
      retryHint: "re-run",
      probe: async () => [{ channel: "telegram", outcome: "failed" }],
      intervalMs: 0,
    });
    expect(failed).toMatch(/webhook registration failed for: telegram/);
    const logs: string[] = [];
    const stuck = await confirmWebhooks({
      baseUrl: "https://x",
      publicUrl: "https://x",
      channels: webhook("feishu"),
      registrars: {},
      log: (m) => logs.push(m),
      retryHint: "re-run",
      probe: async () => [{ channel: "feishu", outcome: "pending" }],
      timeoutMs: 0,
      intervalMs: 0,
    });
    expect(stuck).toMatch(/webhook registration failed for: feishu/);
    expect(logs.join("\n")).toContain("feishu: the box did not report its registration within the wait");
  });

  it("at a terminal, records each URL a person set once the box confirms it, and not before", async () => {
    // Lark without its config API: manual until the person saves the page, then the box reports it registered.
    const reads = [
      [{ channel: "lark", outcome: "manual" as const }],
      [{ channel: "lark", outcome: "manual" as const }],
      [{ channel: "lark", outcome: "registered" as const }],
    ];
    const written: [string, string][] = [];
    const logs: string[] = [];
    const gate = await confirmWebhooks({
      baseUrl: "https://x",
      publicUrl: "https://agent.acme.com",
      channels: webhook("lark"),
      registrars: {},
      log: (m) => logs.push(m),
      retryHint: "re-run",
      probe: async () => reads.shift() ?? [{ channel: "lark", outcome: "registered" }],
      intervalMs: 0,
      record: {
        waitMs: 60_000,
        write: async (kind, url) => {
          written.push([kind, url]);
          return "/work/prod.json";
        },
      },
    });
    expect(gate).toBeUndefined();
    expect(written).toEqual([["lark", "https://agent.acme.com/lark"]]);
    expect(logs.join("\n")).toContain(
      "lark: the platform reached the box at https://agent.acme.com/lark; recorded it in /work/prod.json",
    );
    // A record that cannot be written is said, and the deploy, which is done, ends as it would.
    const unrecorded: string[] = [];
    const notWritten = await confirmWebhooks({
      baseUrl: "https://x",
      publicUrl: "https://agent.acme.com",
      channels: webhook("slack", "lark"),
      registrars: {},
      log: (m) => unrecorded.push(m),
      retryHint: "re-run",
      // Lark manual when the box first reports, then both reached once the person saves the pages.
      probe: (() => {
        let reads = 0;
        return async () =>
          reads++ === 0
            ? [{ channel: "lark", outcome: "manual" as const }]
            : [
                { channel: "slack", outcome: "registered" as const },
                { channel: "lark", outcome: "registered" as const },
              ];
      })(),
      intervalMs: 0,
      record: {
        waitMs: 60_000,
        write: async (kind) => {
          if (kind === "slack") throw new Error("slack: no Slack app onboarded on this machine");
          return "/work/prod.json";
        },
      },
    });
    expect(notWritten).toBeUndefined();
    expect(unrecorded.join("\n")).toContain(
      "slack: the platform reached the box at https://agent.acme.com/slack, but it was not recorded (slack: no Slack app onboarded on this machine); record it with `fastagent channels setup slack --config <file> --record-url`",
    );
    // Both under one deadline, the one wait said once for both.
    expect(unrecorded.filter((m) => m.startsWith("waiting up to"))).toEqual([
      expect.stringContaining("https://agent.acme.com/slack and https://agent.acme.com/lark"),
    ]);
    expect(unrecorded.join("\n")).toContain(
      "lark: the platform reached the box at https://agent.acme.com/lark; recorded it in /work/prod.json",
    );
    // One deadline for both: Lark, reached at once, is recorded at the first read, not after Slack's wait.
    let probes = 0;
    const recordedAt: number[] = [];
    await confirmWebhooks({
      baseUrl: "https://x",
      publicUrl: "https://agent.acme.com",
      channels: webhook("slack", "lark"),
      registrars: {},
      log: () => {},
      retryHint: "re-run",
      probe: async () => {
        probes++;
        return [
          { channel: "slack", outcome: "manual" },
          { channel: "lark", outcome: probes === 1 ? "manual" : "registered" },
        ];
      },
      intervalMs: 1,
      record: {
        waitMs: 50,
        write: async () => {
          recordedAt.push(probes);
          return "f";
        },
      },
    });
    expect(recordedAt).toEqual([2]);
    // The person never saves it: nothing is recorded, and the step stays theirs.
    const never: [string, string][] = [];
    await confirmWebhooks({
      baseUrl: "https://x",
      publicUrl: "https://agent.acme.com",
      channels: webhook("lark"),
      registrars: {},
      log: () => {},
      retryHint: "re-run",
      probe: async () => [{ channel: "lark", outcome: "manual" }],
      intervalMs: 0,
      record: {
        waitMs: 0,
        write: async (kind, url) => {
          never.push([kind, url]);
          return "f";
        },
      },
    });
    expect(never).toEqual([]);
  });

  it("leaves Slack's Request URL to a person: no registrar of the deploy sets it, and the box is not asked", async () => {
    const said: string[] = [];
    const probe = vi.fn(async () => []);
    const gate = await confirmWebhooks({
      baseUrl: "https://x",
      publicUrl: "https://agent.acme.com",
      channels: webhook("slack"),
      registrars: {},
      log: (line) => said.push(line),
      retryHint: "re-run",
      probe,
    });
    expect(gate).toBeUndefined();
    expect(said).toContain("slack: set Event Subscriptions → Request URL → https://agent.acme.com/slack");
    // Nothing of the box's to wait for.
    expect(probe).not.toHaveBeenCalled();
  });
});

describe("every host's runbook reads the same answer", () => {
  const fly = (channels: ReturnType<typeof webhook>) =>
    planFlyDeploy({
      releaseId: "release-one",
      agent: "bot",
      appName: "bot",
      port: 8787,
      runtime: "node",
      hasLockfile: true,
      hasCron: false,
      channels,
    }).runbook.join("\n");

  const railway = (channels: ReturnType<typeof webhook>) =>
    planRailwayDeploy({
      releaseId: "release-one",
      agent: "bot",
      serviceName: "bot",
      runtime: "node",
      hasLockfile: true,
      hasCron: false,
      channels,
    }).runbook.join("\n");

  const agentcore = (channels: ReturnType<typeof webhook>) =>
    planAgentcoreDeploy({
      releaseId: "release-one",
      name: "bot",
      channels,
      runtime: "node",
      hasLockfile: true,
      agent: "bot",
    }).runbook.join("\n");

  it("fly: the box points its own channels, so only Slack's is a person's step", () => {
    const out = fly(webhook("telegram", "slack"));
    expect(out).not.toContain("setWebhook");
    expect(out).toContain("The box points telegram at https://bot.fly.dev itself");
    expect(out).toContain("Request URL = https://bot.fly.dev/slack");
    expect(fly(longConnection("telegram"))).not.toContain("The box points");
  });

  it("railway: with nothing left to point at a domain, the mint step goes too", () => {
    expect(railway(webhook("telegram"))).toContain("railway domain");
    // Otherwise it says "use it in the step(s) below" with no step below it.
    expect(railway(longConnection("telegram"))).not.toContain("railway domain");
  });

  it("agentcore: the runtime points its own channels at the forwarder URL, so only Slack's is a person's step", () => {
    const out = agentcore(webhook("telegram", "slack"));
    expect(out).toContain("makes the runtime point telegram at <ForwarderUrl>");
    expect(out).toContain("Request URL = <ForwarderUrl>/slack");
    expect(out).not.toContain("-d url=<ForwarderUrl>/telegram");
    // `--run` refuses a long-connection channel, but generate-only only warns and still prints this
    // runbook — so the steps filter on ingress rather than on the CLI having gated.
    expect(agentcore(longConnection("telegram"))).not.toContain("makes the runtime point");
    expect(agentcore(webhook("slack"))).not.toContain("makes the runtime point");
  });

  it("agentcore: a feishu step carries the forwarder challenge note the shared wording cannot", () => {
    expect(agentcore(webhook("feishu"))).toContain("rides through the forwarder");
    // ONE note for both kinds: the asides land after all the steps, so a second copy reads as a
    // second step that does not exist.
    const both = agentcore(webhook("feishu", "lark")).split("rides through the forwarder");
    expect(both).toHaveLength(2);
  });
});
