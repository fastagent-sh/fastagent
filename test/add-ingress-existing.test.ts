import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runAddChannel } from "../src/cli/commands/add.ts";
import { channelTemplate } from "../src/scaffold/templates.ts";

// A channel file that names its factory instead of offering both ways (byIngress).
const NAMES_ITS_FACTORY = `import { feishuWebSocketChannel } from "@fastagent-sh/fastagent/feishu";
import { needs } from "@fastagent-sh/fastagent";
export default needs(["FEISHU_APP_ID", "FEISHU_APP_SECRET"], (secrets) =>
  feishuWebSocketChannel({ appId: secrets.FEISHU_APP_ID, appSecret: secrets.FEISHU_APP_SECRET }),
);
`;

let dir: string;
let said: string[];
const exited = new Error("exited");
beforeEach(async () => {
  dir = join(await mkdtemp(join(tmpdir(), "fa-add-existing-")), "fastagent");
  await mkdir(join(dir, "src", "channels"), { recursive: true });
  await writeFile(join(dir, "fastagent.config.ts"), "export default {};\n");
  vi.stubEnv("FASTAGENT_SECRETS_DIR", "");
  vi.stubEnv("FASTAGENT_STATE_DIR", "");
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

const instanceConfig = () => readFile(join(dir, "fastagent.json"), "utf8").catch(() => "");

it("refuses a way the existing channel file cannot receive, before writing it or touching the app", async () => {
  await writeFile(join(dir, "src", "channels", "feishu.ts"), NAMES_ITS_FACTORY);
  await expect(runAddChannel("feishu", dir, { ingress: "webhook", onboard: false })).rejects.toBe(exited);
  expect(said).toContain("exit 1");
  expect(said.join("\n")).toContain(
    'channels.feishu.ingress is "webhook", and src/channels/feishu.ts receives only by websocket: default-export ' +
      "byIngress({ webhook, websocket }) from it to let an instance choose",
  );
  expect(await instanceConfig()).toBe("");
});

it("writes the way to the development instance's configuration, for a channel file that offers both", async () => {
  await writeFile(join(dir, "src", "channels", "feishu.ts"), channelTemplate("feishu", "channel.ts"));
  await expect(runAddChannel("feishu", dir, { ingress: "webhook", onboard: false })).rejects.toBe(exited);
  expect(said).toContain("exit 0");
  expect(JSON.parse(await instanceConfig())).toEqual({ channels: { feishu: { ingress: "webhook" } } });
  // Never the value file: how a channel receives is configuration, not a secret.
  expect(await readFile(join(dir, ".secrets", ".env"), "utf8").catch(() => "")).not.toMatch(/INGRESS/);
});

it("refuses a way the configuration misspells before touching the app", async () => {
  await writeFile(join(dir, "src", "channels", "feishu.ts"), channelTemplate("feishu", "channel.ts"));
  const written = JSON.stringify({ channels: { feishu: { ingress: "socket" } } });
  await writeFile(join(dir, "fastagent.json"), written);
  await expect(runAddChannel("feishu", dir, { onboard: false })).rejects.toBe(exited);
  expect(said).toContain("exit 1");
  expect(said.join("\n")).toMatch(/fastagent\.json: \/channels\/feishu\/ingress/);
  expect(await instanceConfig()).toBe(written);
  expect(await readFile(join(dir, ".secrets", ".env"), "utf8").catch(() => "")).toBe("");
});

it("writes a deployment's way only to the configuration it names", async () => {
  await writeFile(join(dir, "src", "channels", "feishu.ts"), channelTemplate("feishu", "channel.ts"));
  await expect(
    runAddChannel("feishu", dir, { ingress: "websocket", environment: "production", onboard: false }),
  ).rejects.toBe(exited);
  expect(said).toContain("exit 2");
  expect(said.join("\n")).toContain("--ingress with --env production is a deployment's configuration: pass --config");
  const config = join(dir, "..", "production.json");
  await expect(
    runAddChannel("feishu", dir, { ingress: "websocket", environment: "production", onboard: false, config }),
  ).rejects.toBe(exited);
  expect(JSON.parse(await readFile(config, "utf8"))).toEqual({ channels: { feishu: { ingress: "websocket" } } });
  expect(await instanceConfig()).toBe("");
});
