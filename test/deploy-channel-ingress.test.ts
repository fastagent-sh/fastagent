import { describe, expect, it, vi } from "vitest";
import { declaredChannels } from "../src/channels/discover.ts";
import type { RegistrationOutcome } from "../src/channels/registration.ts";
import { planAgentcoreDeploy } from "../src/deploy/agentcore/plan.ts";
import { registerWebhooks, webhookKinds, webhookPaths, webhookRunbook } from "../src/deploy/channel-ingress.ts";
import { planFlyDeploy } from "../src/deploy/fly/plan.ts";
import { planRailwayDeploy } from "../src/deploy/railway/plan.ts";

const registered = (): Promise<RegistrationOutcome> => Promise.resolve("registered");
const webhook = (...names: string[]) => declaredChannels(names);
const longConnection = (...names: string[]) => declaredChannels(names, "long-connection");

describe("deploy/channel-ingress: which channels have a webhook", () => {
  it("answers in declaration order, whatever order the channels arrive in", () => {
    expect(webhookKinds(webhook("lark", "github", "telegram"))).toEqual(["telegram", "github", "lark"]);
    expect(webhookPaths(webhook("slack", "github"))).toEqual(["/webhook", "/slack"]);
  });

  it("EVERY long-connection channel is excluded, not just feishu/lark", () => {
    // The rule used to be spelled per host and only reached the feishu/lark branches. A long-connection
    // telegram is the case that made it expensive: setting a webhook makes getUpdates return 409, so a
    // runbook that prints setWebhook stops the channel the operator just deployed.
    expect(webhookKinds([...longConnection("telegram"), ...webhook("github")])).toEqual(["github"]);
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
      channels: webhook("github", "slack"), // github never has a registrar; slack's is not wired here
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
      channels: webhook("telegram", "feishu"),
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
  const fly = (channels: ReturnType<typeof webhook>) =>
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
    }).runbook.join("\n");

  const railway = (channels: ReturnType<typeof webhook>) =>
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
    }).runbook.join("\n");

  const agentcore = (channels: ReturnType<typeof webhook>) =>
    planAgentcoreDeploy({
      name: "bot",
      modelAuth: undefined,
      channels,
      schedules: [],
      selfSchedule: false,
      hasPackageJson: true,
      runtime: "node",
      hasLockfile: true,
      version: "9.9.9",
      agentPrefix: "",
    }).runbook.join("\n");

  it("fly: a long-connection telegram gets no setWebhook step", () => {
    expect(fly(webhook("telegram"))).toContain("setWebhook");
    expect(fly(longConnection("telegram"))).not.toContain("setWebhook");
  });

  it("railway: with nothing left to point at a domain, the mint step goes too", () => {
    expect(railway(webhook("telegram"))).toContain("railway domain");
    // Otherwise it says "use it in the step(s) below" with no step below it.
    expect(railway(longConnection("telegram"))).not.toContain("railway domain");
  });

  it("agentcore: the same steps at the forwarder URL, and generate-only skips a long-connection one", () => {
    const out = agentcore(webhook("telegram", "github"));
    expect(out).toContain("-d url=<ForwarderUrl>/telegram");
    expect(out).toContain("Payload URL = <ForwarderUrl>/webhook");
    expect(out).toContain("8 h compute ceiling"); // AgentCore's own aside stays with AgentCore
    // `--run` refuses a long-connection channel, but generate-only only warns and still prints this
    // runbook — so the steps filter on ingress rather than on the CLI having gated.
    expect(agentcore(longConnection("telegram"))).not.toContain("setWebhook");
  });

  it("agentcore: a feishu step carries the forwarder challenge note the shared wording cannot", () => {
    expect(agentcore(webhook("feishu"))).toContain("rides through the forwarder");
  });
});
