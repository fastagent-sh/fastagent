import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { channelIngress } from "../src/channels/discover.ts";
import { codeSecrets } from "../src/harnesses/pi-durable/definition.ts";
import { buildDefinition, loadSourceDefinition } from "../src/harnesses/pi-durable/open.ts";
import { scaffoldChannel } from "../src/scaffold/add-channel.ts";
import { DEV_SERVE_ENV } from "../src/serving-command.ts";

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

it("the telegram scaffold polls under dev and takes a webhook everywhere else, asking only for that way's secrets", async () => {
  const dir = join(await mkdtemp(join(tmpdir(), "fa-telegram-ingress-")), "fastagent");
  dirs.push(dir);
  await mkdir(dir, { recursive: true });
  await scaffoldChannel(dir, "telegram");
  const definition = await loadSourceDefinition(dir);
  const every = Object.fromEntries(definition.inputs.secrets.map(({ name }) => [name, "1:A"]));
  const shapeUnder = (dev: boolean, ingress?: "webhook" | "connection") => {
    vi.stubEnv(DEV_SERVE_ENV, dev ? "1" : "");
    const config = { settings: {}, ...(ingress === undefined ? {} : { channels: { telegram: { ingress } } }) };
    return {
      ingress: [...buildDefinition(definition, every, config).channels.values()].map(channelIngress),
      secrets: codeSecrets(definition, config).map((secret) => secret.name),
    };
  };
  const webhook = { ingress: ["webhook"], secrets: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_SECRET_TOKEN"] };
  const polling = { ingress: ["long-connection"], secrets: ["TELEGRAM_BOT_TOKEN"] };
  expect(shapeUnder(false)).toEqual(webhook);
  expect(shapeUnder(true)).toEqual(polling);
  expect(shapeUnder(false, "connection")).toEqual(polling);
  expect(shapeUnder(true, "webhook")).toEqual(webhook);

  // An instance that polls opens without the webhook's secret, and one that receives by webhook does not.
  vi.stubEnv(DEV_SERVE_ENV, "");
  const { TELEGRAM_SECRET_TOKEN: _secret, ...withoutSecret } = every;
  expect(() =>
    buildDefinition(definition, withoutSecret, { settings: {}, channels: { telegram: { ingress: "connection" } } }),
  ).not.toThrow();
  expect(() => buildDefinition(definition, withoutSecret, { settings: {} })).toThrow("TELEGRAM_SECRET_TOKEN");
});
