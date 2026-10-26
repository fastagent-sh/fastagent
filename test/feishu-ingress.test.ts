import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { channelIngress } from "../src/channels/discover.ts";
import { feishuIngressFor } from "../src/channels/feishu/setup-mode.ts";
import { buildDefinition, prepareDefinition, secretsManifest } from "../src/harnesses/pi-durable/open.ts";
import { scaffoldChannel } from "../src/scaffold/add-channel.ts";
import { DEV_SERVE_ENV, markDevServe, servedByDev } from "../src/serving-command.ts";

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("Feishu/Lark ingress: one rule, read by the channel and by everything that reads its shape", () => {
  it("names a setting when one is set, else WebSocket under dev and webhook everywhere else", () => {
    expect(feishuIngressFor("feishu", {})).toBe("webhook");
    expect(feishuIngressFor("feishu", { [DEV_SERVE_ENV]: "1" })).toBe("websocket");
    expect(feishuIngressFor("feishu", { FEISHU_INGRESS: "webhook", [DEV_SERVE_ENV]: "1" })).toBe("webhook");
    expect(feishuIngressFor("lark", { LARK_INGRESS: " websocket " })).toBe("websocket");
    // Each cloud reads its own setting.
    expect(feishuIngressFor("lark", { FEISHU_INGRESS: "websocket" })).toBe("webhook");
    expect(() => feishuIngressFor("feishu", { FEISHU_INGRESS: "ws" })).toThrow(
      'FEISHU_INGRESS must be "webhook" or "websocket", got "ws"',
    );
  });

  it("dev marks the process it serves in", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(servedByDev(env)).toBe(false);
    markDevServe(env);
    expect(servedByDev(env)).toBe(true);
  });

  it.each(["feishu", "lark"] as const)(
    "the %s scaffold takes the shape the rule names, so deploy's reading sees what start will serve",
    async (kind) => {
      const prefix = kind.toUpperCase();
      const shapeUnder = async (env: Record<string, string>) => {
        // A fresh file per environment: the module system caches an import by its URL.
        const dir = join(await mkdtemp(join(tmpdir(), `fa-${kind}-ingress-`)), "fastagent");
        dirs.push(dir);
        await mkdir(dir, { recursive: true });
        await scaffoldChannel(dir, kind);
        vi.stubEnv(DEV_SERVE_ENV, env[DEV_SERVE_ENV] ?? "");
        vi.stubEnv(`${prefix}_INGRESS`, env[`${prefix}_INGRESS`] ?? "");
        const definition = await prepareDefinition(dir);
        const secrets = secretsManifest(definition);
        const code = buildDefinition(definition, Object.fromEntries(secrets.map(({ name }) => [name, "set"])));
        return {
          ingress: [...code.channels.values()].map(channelIngress),
          secrets: secrets.filter((secret) => !secret.optional).map((secret) => secret.name),
        };
      };
      expect(await shapeUnder({})).toEqual({
        ingress: ["webhook"],
        secrets: [`${prefix}_APP_ID`, `${prefix}_APP_SECRET`, `${prefix}_VERIFICATION_TOKEN`],
      });
      expect(await shapeUnder({ [DEV_SERVE_ENV]: "1" })).toEqual({
        ingress: ["long-connection"],
        secrets: [`${prefix}_APP_ID`, `${prefix}_APP_SECRET`],
      });
      expect(await shapeUnder({ [`${prefix}_INGRESS`]: "websocket" })).toEqual({
        ingress: ["long-connection"],
        secrets: [`${prefix}_APP_ID`, `${prefix}_APP_SECRET`],
      });
    },
  );
});
