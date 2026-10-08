import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

// The onboarding itself (Manifest API, OAuth) is add-slack's and tested there; this is what `add` prints after it.
vi.mock("../src/cli/add-slack.ts", () => ({ onboardSlackInternalApp: vi.fn(async () => {}) }));
const { runAddChannel } = await import("../src/cli/commands/add.ts");

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

it("an onboarded Slack app's next steps name every tool the scaffold wrote", async () => {
  const dir = join(await mkdtemp(join(tmpdir(), "fa-add-slack-")), "fastagent");
  dirs.push(dir);
  await mkdir(dir);
  await writeFile(join(dir, "fastagent.config.ts"), "export default {};\n");
  await writeFile(
    join(dir, "package.json"),
    `${JSON.stringify({ type: "module", dependencies: { "@fastagent-sh/fastagent": "^0.4.0" } })}\n`,
  );
  vi.stubEnv("FASTAGENT_STATE_DIR", "");
  vi.stubEnv("FASTAGENT_SECRETS_DIR", "");
  const printed = vi.spyOn(console, "error").mockImplementation(() => {});
  // The command ends the process once its output is written (app-creation flows leave sockets open).
  const exited = new Error("exited");
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw exited;
  });
  await expect(runAddChannel("slack", dir, { onboard: true })).rejects.toBe(exited);
  const out = printed.mock.calls.map((call) => call.join(" ")).join("\n");
  expect(out).toContain("tools/slack-send.ts tool");
  expect(out).toContain("tools/slack-threads.ts tool");
});
