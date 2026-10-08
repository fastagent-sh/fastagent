import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runAddChannel } from "../src/cli/commands/add.ts";
import { channelTemplate } from "../src/scaffold/templates.ts";

// A channel file scaffolded before FEISHU_INGRESS existed: it names its factory.
const NAMES_ITS_FACTORY = `import { feishuWebSocketChannel } from "@fastagent-sh/fastagent/feishu";
import { defineChannel } from "@fastagent-sh/fastagent";
export default defineChannel({
  secrets: ["FEISHU_APP_ID", "FEISHU_APP_SECRET"],
  channel: (secrets) => feishuWebSocketChannel({ appId: secrets.FEISHU_APP_ID, appSecret: secrets.FEISHU_APP_SECRET }),
});
`;

let dir: string;
let said: string[];
const exited = new Error("exited");
beforeEach(async () => {
  dir = join(await mkdtemp(join(tmpdir(), "fa-add-existing-")), "fastagent");
  await mkdir(join(dir, "channels"), { recursive: true });
  await writeFile(join(dir, "fastagent.config.ts"), "export default {};\n");
  vi.stubEnv("FASTAGENT_SECRETS_DIR", "");
  vi.stubEnv("FASTAGENT_STATE_DIR", "");
  vi.stubEnv("FEISHU_INGRESS", "");
  said = [];
  vi.spyOn(console, "error").mockImplementation((line) => void said.push(String(line)));
  vi.spyOn(process, "exit").mockImplementation((code) => {
    said.push(`exit ${code}`);
    throw exited;
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

const dotEnv = () => readFile(join(dir, ".secrets", ".env"), "utf8").catch(() => "");

it("refuses a setting the existing channel file does not read, before writing it or touching the app", async () => {
  await writeFile(join(dir, "channels", "feishu.ts"), NAMES_ITS_FACTORY);
  await expect(runAddChannel("feishu", dir, { ingress: "webhook", onboard: false })).rejects.toBe(exited);
  expect(said).toContain("exit 1");
  expect(said.join("\n")).toContain(
    "channels/feishu.ts receives by WebSocket whatever FEISHU_INGRESS says — it names its factory instead of reading " +
      "the setting, so FEISHU_INGRESS=webhook would change nothing but the app",
  );
  expect(await dotEnv()).not.toMatch(/FEISHU_INGRESS/);
});

it("writes the setting for a channel file that reads it", async () => {
  await writeFile(join(dir, "channels", "feishu.ts"), channelTemplate("feishu", "channel.ts"));
  await expect(runAddChannel("feishu", dir, { ingress: "webhook", onboard: false })).rejects.toBe(exited);
  expect(said).toContain("exit 0");
  expect(await dotEnv()).toMatch(/^FEISHU_INGRESS=webhook$/m);
});
