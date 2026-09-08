import { expect, it, vi } from "vitest";
import { createAgentcoreStorage, storageStackName } from "./live/agentcore-storage.ts";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(() => {
    throw new Error("unexpected AWS call");
  }),
}));

it("keeps live storage inside the probe namespace and requires an explicit network", async () => {
  expect(storageStackName("live-probe-1234abcd")).toBe("fastagent-live-probe-1234abcd-storage");
  expect(() => storageStackName("production")).toThrow("invalid AgentCore probe name");
  for (const network of [
    { subnetIds: [], securityGroupIds: ["sg-1234abcd"] },
    { subnetIds: ["subnet-1234abcd"], securityGroupIds: [] },
  ]) {
    await expect(createAgentcoreStorage("live-probe-1234abcd", network)).rejects.toThrow(
      "requires subnetIds and securityGroupIds",
    );
  }
});
