import { describe, expect, it, vi } from "vitest";
import type { RegistrationOutcome } from "../src/channels/registration.ts";
import { registerWebhooks, webhookChannels, webhookPaths, webhookRunbook } from "../src/deploy/channel-ingress.ts";
import { planAgentcoreDeploy } from "../src/deploy/agentcore/plan.ts";
import { planFlyDeploy } from "../src/deploy/fly/plan.ts";
import { planRailwayDeploy } from "../src/deploy/railway/plan.ts";

const registered = (): Promise<RegistrationOutcome> => Promise.resolve("registered");

describe("deploy/channel-ingress: which channels have a webhook", () => {
  it("answers in declaration order, whatever order the channels arrive in", () => {
    expect(webhookChannels(["lark", "github", "telegram"])).toEqual(["telegram", "github", "lark"]);
    expect(webhookPaths(["slack", "github"])).toEqual(["/webhook", "/slack"]);
  });

  it("EVERY long-connection channel is excluded, not just feishu/lark", () => {
    // The rule used to be spelled per host and only reached the feishu/lark branches. A long-connection
    // telegram is the case that made it expensive: setting a webhook makes getUpdates return 409, so a
    // runbook that prints setWebhook stops the channel the operator just deployed.
    expect(webhookChannels(["telegram", "github"], ["telegram"])).toEqual(["github"]);
    expect(webhookRunbook("https://x", ["telegram"], ["telegram"])).toEqual([]);
    expect(webhookPaths(["telegram", "slack"], ["telegram", "slack"])).toEqual([]);
  });

  it("does not register one either — the connection IS the ingress", async () => {
    const telegram = vi.fn(registered);
    const gate = await registerWebhooks({
      baseUrl: "https://x",
      channels: ["telegram"],
      longConnectionChannels: ["telegram"],
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
      channels: ["github", "slack"], // github never has a registrar; slack's is not wired here
      registrars: { telegram: vi.fn(registered) },
      log: (m) => said.push(m),
      retryHint: "re-run",
    });
    expect(said.filter((m) => m.includes("https://x"))).toHaveLength(2);
    expect(said.join("\n")).toContain("Settings → Webhooks");
    expect(said.join("\n")).toContain("Event Subscriptions");
    // manual never gates: a re-run cannot clear it, and an unclearable gate spins a coding agent.
    expect(gate).toBeUndefined();
  });

  it("a failed registrar gates, and one failure does not skip the rest", async () => {
    const feishu = vi.fn(async (): Promise<RegistrationOutcome> => "registered");
    const gate = await registerWebhooks({
      baseUrl: "https://x",
      channels: ["telegram", "feishu"],
      registrars: { telegram: async () => "failed", feishu },
      log: () => {},
      retryHint: "re-run with --into-linked",
    });
    expect(feishu).toHaveBeenCalledWith("https://x", "feishu");
    expect(gate).toContain("telegram");
    expect(gate).toContain("re-run with --into-linked");
  });
});

describe("every host's runbook reads the same answer", () => {
  const fly = (channels: ("telegram" | "github")[], longConnectionChannels?: string[]) =>
    planFlyDeploy({
      agentPrefix: "fastagent/",
      appName: "bot",
      port: 8787,
      hasPackageJson: true,
      runtime: "node",
      hasLockfile: true,
      version: "9.9.9",
      autostop: "suspend",
      scaleToZero: true,
      hasTimeTriggers: false,
      modelAuth: undefined,
      channels,
      longConnectionChannels,
    }).runbook.join("\n");

  it("fly: a long-connection telegram gets no setWebhook step", () => {
    expect(fly(["telegram"])).toContain("setWebhook");
    expect(fly(["telegram"], ["telegram"])).not.toContain("setWebhook");
  });

  it("railway: with nothing left to point at a domain, the mint step goes too", () => {
    const runbook = (channels: ("telegram" | "github")[], longConnectionChannels?: string[]) =>
      planRailwayDeploy({
        agentPrefix: "fastagent/",
        serviceName: "bot",
        hasPackageJson: true,
        runtime: "node",
        hasLockfile: true,
        version: "9.9.9",
        hasTimeTriggers: false,
        modelAuth: undefined,
        channels,
        longConnectionChannels,
      }).runbook.join("\n");
    expect(runbook(["telegram"])).toContain("railway domain");
    // Otherwise it says "use it in the webhook step(s) below" with no step below it.
    expect(runbook(["telegram"], ["telegram"])).not.toContain("railway domain");
  });

  it("agentcore: the same steps, pointed at the forwarder URL", () => {
    const runbook = planAgentcoreDeploy({
      name: "bot",
      modelAuth: undefined,
      channels: ["telegram", "github"],
      routeChannels: ["telegram", "github"],
      schedules: [],
      selfSchedule: false,
      hasPackageJson: true,
      runtime: "node",
      hasLockfile: true,
      version: "9.9.9",
      agentPrefix: "",
    }).runbook.join("\n");
    expect(runbook).toContain("-d url=<ForwarderUrl>/telegram");
    expect(runbook).toContain("Payload URL = <ForwarderUrl>/webhook");
    // AgentCore's own aside stays with AgentCore.
    expect(runbook).toContain("8 h compute ceiling");
  });
});
