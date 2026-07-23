import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendChannelDotEnv, channelSetup, scaffoldChannel } from "../src/scaffold/add-channel.ts";

describe("channel setup guidance", () => {
  it("puts recommended context-aware permission approval before publishing and explains mention-only degradation", () => {
    for (const kind of ["feishu", "lark"] as const) {
      for (const ingress of ["webhook", "websocket"] as const) {
        const contextSteps = channelSetup(kind, ingress, "context").steps;
        const scopeIndex = contextSteps.findIndex((step) => step.includes("im:message.group_msg"));
        const publishIndex = contextSteps.findIndex((step, index) => index > scopeIndex && /publish/i.test(step));
        expect(scopeIndex).toBeGreaterThanOrEqual(0);
        expect(publishIndex).toBeGreaterThan(scopeIndex);
        expect(contextSteps[scopeIndex]).toContain("all group messages");
        expect(contextSteps[scopeIndex]).not.toContain("optional");

        const mentionSteps = channelSetup(kind, ingress, "mentions").steps;
        expect(mentionSteps.join("\n")).toContain("mention-only");
        expect(mentionSteps.join("\n")).toContain("bare managed-thread replies");
        expect(mentionSteps.join("\n")).toContain("disabled");
      }
    }
  });

  it("Slack group choice changes scopes/guidance and the generated runtime policy", async () => {
    const context = channelSetup("slack", "webhook", "context");
    expect(context.env.map((entry) => entry.name)).toEqual([
      "SLACK_BOT_TOKEN",
      "SLACK_BOT_REFRESH_TOKEN",
      "SLACK_BOT_TOKEN_EXPIRES_AT",
      "SLACK_CLIENT_ID",
      "SLACK_CLIENT_SECRET",
      "SLACK_SIGNING_SECRET",
    ]);
    expect(context.steps.join("\n")).toContain("channels:history");
    expect(context.steps.join("\n")).toContain("message.channels");

    const mentions = channelSetup("slack", "webhook", "mentions");
    expect(channelSetup("slack").steps).toEqual(context.steps);
    expect(mentions.steps.join("\n")).toContain("mention-only");
    expect(mentions.steps.join("\n")).not.toContain("message.channels");

    const dir = await mkdtemp(join(tmpdir(), "fa-slack-scaffold-"));
    await scaffoldChannel(dir, "slack");
    const source = await readFile(join(dir, "channels", "slack.ts"), "utf8");
    expect(source).toContain('groupBehavior: "context"');
    expect(source).toContain('rendering: "native"');
    expect(await readFile(join(dir, "tools", "slack-send.ts"), "utf8")).toContain("files.completeUploadExternal");

    const mentionsDir = await mkdtemp(join(tmpdir(), "fa-slack-mentions-scaffold-"));
    await scaffoldChannel(mentionsDir, "slack", { groupBehavior: "mentions" });
    expect(await readFile(join(mentionsDir, "channels", "slack.ts"), "utf8")).toContain('groupBehavior: "mentions"');
  });

  it("WebSocket setup needs only App ID/Secret and writes the WebSocket factory into the scaffold", async () => {
    const setup = channelSetup("feishu", "websocket");
    expect(setup.env.map((entry) => entry.name)).toEqual(["FEISHU_APP_ID", "FEISHU_APP_SECRET"]);
    expect(setup.steps.join("\n")).toContain("without --tunnel");

    const dir = await mkdtemp(join(tmpdir(), "fa-ws-scaffold-"));
    await scaffoldChannel(dir, "feishu", { ingress: "websocket" });
    const source = await readFile(join(dir, "channels", "feishu.ts"), "utf8");
    expect(source).toContain("feishuWebSocketChannel");
    expect(source).not.toContain("feishuChannel(");
    expect(source).not.toContain("ingress:");
    expect(source).not.toContain("FEISHU_VERIFICATION_TOKEN");
    expect(source).not.toContain("FEISHU_ENCRYPT_KEY");
  });
});

describe("appendChannelDotEnv", () => {
  it("keeps existing values by default; overwrite names replace stale lines IN PLACE (fresh credentials must not lose)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-env-"));
    await writeFile(join(dir, ".env"), "LARK_APP_ID=cli_old\nLARK_APP_SECRET=old_secret\n");

    // Default: existing non-empty values win, the new ones are dropped as alreadySet.
    let r = await appendChannelDotEnv(dir, "lark", { LARK_APP_ID: "cli_new", LARK_APP_SECRET: "s2" });
    expect(r.alreadySet).toEqual(expect.arrayContaining(["LARK_APP_ID", "LARK_APP_SECRET"]));
    expect(await readFile(join(dir, ".env"), "utf8")).toContain("LARK_APP_ID=cli_old");

    // Overwrite: `add feishu`'s create flow just minted these — the stale line loses, in place (no duplicate
    // assignment that last-wins would then shadow).
    r = await appendChannelDotEnv(dir, "lark", { LARK_APP_ID: "cli_new", LARK_APP_SECRET: "s2" }, [
      "LARK_APP_ID",
      "LARK_APP_SECRET",
    ]);
    expect(r.written).toEqual(expect.arrayContaining(["LARK_APP_ID", "LARK_APP_SECRET"]));
    const content = await readFile(join(dir, ".env"), "utf8");
    expect(content).toContain("LARK_APP_ID=cli_new");
    expect(content).toContain("LARK_APP_SECRET=s2");
    expect(content).not.toContain("cli_old");
    expect(content.match(/^LARK_APP_ID=/gm)?.length).toBe(1);
  });

  it("persists irreversible Feishu credentials in stages so an interrupted bootstrap can resume", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-env-staged-"));
    await writeFile(join(dir, ".env"), "FEISHU_VERIFICATION_TOKEN=stale-other-app-token\n");

    await appendChannelDotEnv(
      dir,
      "feishu",
      {
        FEISHU_APP_ID: "cli_new",
        FEISHU_APP_SECRET: "one-time-secret",
        FEISHU_VERIFICATION_TOKEN: "",
      },
      ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_VERIFICATION_TOKEN"],
    );
    const interrupted = await readFile(join(dir, ".env"), "utf8");
    expect(interrupted).toContain("FEISHU_APP_ID=cli_new");
    expect(interrupted).toContain("FEISHU_APP_SECRET=one-time-secret");
    expect(interrupted).not.toContain("stale-other-app-token");
    expect(interrupted).not.toContain("FEISHU_VERIFICATION_TOKEN=token-1");

    await appendChannelDotEnv(dir, "feishu", { FEISHU_VERIFICATION_TOKEN: "token-1" }, ["FEISHU_VERIFICATION_TOKEN"]);
    const completed = await readFile(join(dir, ".env"), "utf8");
    expect(completed).toContain("FEISHU_APP_ID=cli_new");
    expect(completed).toContain("FEISHU_APP_SECRET=one-time-secret");
    expect(completed).toContain("FEISHU_VERIFICATION_TOKEN=token-1");
    expect(completed.match(/^FEISHU_APP_ID=/gm)?.length).toBe(1);
    expect(completed.match(/^FEISHU_VERIFICATION_TOKEN=/gm)?.length).toBe(1);
  });
});
