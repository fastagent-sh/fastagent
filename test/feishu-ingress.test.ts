import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { channelIngress } from "../src/channels/discover.ts";
import { resolveConfig } from "../src/harnesses/pi-durable/config.ts";
import { chosenIngress, codeSecrets } from "../src/harnesses/pi-durable/definition.ts";
import { buildDefinition, loadSourceDefinition } from "../src/harnesses/pi-durable/open.ts";
import { scaffoldChannel } from "../src/scaffold/add-channel.ts";
import { DEV_SERVE_ENV, markDevServe, servedByDev } from "../src/serving-command.ts";

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function agentDir(prefix: string): Promise<string> {
  const dir = join(await mkdtemp(join(tmpdir(), prefix)), "fastagent");
  dirs.push(dir);
  await mkdir(dir, { recursive: true });
  return dir;
}

describe("a channel's ingress: the instance's configuration, else dev's WebSocket and everyone else's webhook", () => {
  it("names the configured way, else WebSocket under dev and webhook everywhere else", () => {
    expect(chosenIngress({}, "feishu", false)).toBe("webhook");
    expect(chosenIngress({}, "feishu", true)).toBe("websocket");
    expect(chosenIngress({ channels: { feishu: { ingress: "webhook" } } }, "feishu", true)).toBe("webhook");
    expect(chosenIngress({ channels: { feishu: { ingress: "websocket" } } }, "feishu", false)).toBe("websocket");
    // Each channel by its own name.
    expect(chosenIngress({ channels: { lark: { ingress: "websocket" } } }, "feishu", false)).toBe("webhook");
  });

  it("dev marks the process it serves in", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(servedByDev(env)).toBe(false);
    markDevServe(env);
    expect(servedByDev(env)).toBe(true);
  });

  it.each(["feishu", "lark"] as const)(
    "the %s scaffold takes the way its configuration chooses, and asks only for that way's secrets",
    async (kind) => {
      const prefix = kind.toUpperCase();
      const dir = await agentDir(`fa-${kind}-ingress-`);
      await scaffoldChannel(dir, kind);
      const definition = await loadSourceDefinition(dir);
      const every = Object.fromEntries(definition.inputs.secrets.map(({ name }) => [name, "set"]));
      const shapeUnder = (dev: boolean, ingress?: "webhook" | "websocket") => {
        vi.stubEnv(DEV_SERVE_ENV, dev ? "1" : "");
        const config = { settings: {}, ...(ingress === undefined ? {} : { channels: { [kind]: { ingress } } }) };
        return {
          ingress: [...buildDefinition(definition, every, config).channels.values()].map(channelIngress),
          secrets: codeSecrets(definition, config)
            .filter((secret) => !secret.optional)
            .map((secret) => secret.name),
        };
      };
      const webhook = {
        ingress: ["webhook"],
        secrets: [`${prefix}_APP_ID`, `${prefix}_APP_SECRET`, `${prefix}_VERIFICATION_TOKEN`],
      };
      const websocket = { ingress: ["long-connection"], secrets: [`${prefix}_APP_ID`, `${prefix}_APP_SECRET`] };
      expect(shapeUnder(false)).toEqual(webhook);
      expect(shapeUnder(true)).toEqual(websocket);
      expect(shapeUnder(false, "websocket")).toEqual(websocket);
      expect(shapeUnder(true, "webhook")).toEqual(webhook);
      // A websocket instance opens without the webhook's token.
      vi.stubEnv(DEV_SERVE_ENV, "");
      const { [`${prefix}_VERIFICATION_TOKEN`]: _token, ...withoutToken } = every;
      expect(() =>
        buildDefinition(definition, withoutToken, { settings: {}, channels: { [kind]: { ingress: "websocket" } } }),
      ).not.toThrow();
      expect(() => buildDefinition(definition, withoutToken, { settings: {} })).toThrow(`${prefix}_VERIFICATION_TOKEN`);
      // The definition's own list is every way's, each said beside its file.
      expect(definition.inputs.secrets.find(({ name }) => name === `${prefix}_VERIFICATION_TOKEN`)).toMatchObject({
        optional: false,
        declaredIn: [`src/channels/${kind}.ts (webhook)`],
      });
    },
  );

  it("refuses a way a channel that names its factory cannot receive, saying how to let an instance choose", async () => {
    const dir = await agentDir("fa-fixed-ingress-");
    await mkdir(join(dir, "src", "channels"), { recursive: true });
    await writeFile(
      join(dir, "src", "channels", "hook.ts"),
      `export default () => ({ "POST /hook": () => new Response("ok") });\n`,
    );
    const definition = await loadSourceDefinition(dir);
    expect(() =>
      buildDefinition(definition, {}, { settings: {}, channels: { hook: { ingress: "webhook" } } }),
    ).not.toThrow();
    expect(() =>
      buildDefinition(definition, {}, { settings: {}, channels: { hook: { ingress: "websocket" } } }),
    ).toThrow(
      'channels.hook.ingress is "websocket", and src/channels/hook.ts receives only by webhook: default-export ' +
        "byIngress({ webhook, websocket }) from it to let an instance choose",
    );
  });

  it("refuses a way of byIngress that builds the other way's channel", async () => {
    const dir = await agentDir("fa-swapped-ingress-");
    await mkdir(join(dir, "src", "channels"), { recursive: true });
    await writeFile(
      join(dir, "src", "channels", "hook.ts"),
      `const routes = () => ({ "POST /hook": () => new Response("ok") });\n` +
        `export default { kind: "fastagent.by-ingress", webhook: routes, websocket: routes };\n`,
    );
    const definition = await loadSourceDefinition(dir);
    expect(() =>
      buildDefinition(definition, {}, { settings: {}, channels: { hook: { ingress: "websocket" } } }),
    ).toThrow("src/channels/hook.ts: its websocket way builds a channel that receives by webhook");
  });

  it("refuses a configuration naming a channel the agent does not have", async () => {
    const dir = await agentDir("fa-unknown-channel-");
    await scaffoldChannel(dir, "feishu");
    const definition = await loadSourceDefinition(dir);
    expect(() =>
      resolveConfig(definition, { values: { channels: { slack: { ingress: "websocket" } } }, label: "fastagent.json" }),
    ).toThrow("fastagent.json: channels.slack names no channel of fastagent (its channels: feishu)");
    expect(() =>
      resolveConfig(definition, { values: { channels: { feishu: { ingress: "socket" } } }, label: "fastagent.json" }),
    ).toThrow("fastagent.json");
    expect(
      resolveConfig(definition, { values: { channels: { feishu: { ingress: "websocket" } } }, label: "fastagent.json" })
        .sources,
    ).toMatchObject({ "channels.feishu.ingress": "fastagent.json" });
  });
});
