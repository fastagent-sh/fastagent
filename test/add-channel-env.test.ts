import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendChannelDotEnv,
  channelSetup,
  scaffoldChannel,
  scaffoldCompanionTools,
} from "../src/scaffold/add-channel.ts";

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
        expect(mentionSteps.join("\n")).toContain("bare thread replies");
        expect(mentionSteps.join("\n")).toContain("disabled");
      }
    }
  });

  it("Slack group choice changes scopes/guidance and the generated runtime policy", async () => {
    const context = channelSetup("slack", "webhook", "context");
    expect(context.env.map((entry) => entry.name)).toEqual(["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"]);
    expect(context.steps.join("\n")).toContain("channels:history");
    expect(context.steps.join("\n")).toContain("message.channels");

    const mentions = channelSetup("slack", "webhook", "mentions");
    expect(channelSetup("slack").steps).toEqual(context.steps);
    expect(mentions.steps.join("\n")).toContain("mention-only");
    expect(mentions.steps.join("\n")).not.toContain("message.channels");

    const dir = await mkdtemp(join(tmpdir(), "fa-slack-scaffold-"));
    await scaffoldChannel(dir, "slack");
    // A companion tool from an earlier package version is replaced on re-add; the channel file is not.
    await mkdir(join(dir, "tools"));
    await writeFile(join(dir, "tools", "slack-send.ts"), "// 0.20.0: process.env.SLACK_BOT_TOKEN");
    await scaffoldCompanionTools(dir, "slack");
    const source = await readFile(join(dir, "channels", "slack.ts"), "utf8");
    expect(source).toContain('rendering: "native"');
    expect(await readFile(join(dir, "tools", "slack-send.ts"), "utf8")).toContain("slackTransport(ctx.cwd)");
  });

  it("a kind with no long-connection template says so, instead of an ENOENT for a path nobody named", async () => {
    // The CLI's resolveIngress only asks for websocket on feishu/lark, but that is the caller's
    // guarantee, not this function's: `scaffoldChannel` is exported and a new kind may arrive first.
    const dir = await mkdtemp(join(tmpdir(), "fa-ws-missing-"));
    await expect(scaffoldChannel(dir, "telegram", { ingress: "websocket" })).rejects.toThrow(
      /telegram has no websocket scaffold/,
    );
    // The "available" list names CHANNEL templates only — a companion tool in the same bundle is not
    // an ingress anyone can ask for, and offering it sends the reader after the wrong file.
    await expect(scaffoldChannel(dir, "telegram", { ingress: "websocket" })).rejects.toThrow(
      /available: channel\.ts$/m,
    );
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
  it("writes to the RESOLVED secrets dir — FASTAGENT_SECRETS_DIR moves the .env target with the protection", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-env-move-"));
    const secrets = await mkdtemp(join(tmpdir(), "fa-env-external-"));
    await chmod(secrets, 0o755); // an existing dir the operator (or a volume mount) left wide open
    process.env.FASTAGENT_SECRETS_DIR = secrets;
    try {
      const r = await appendChannelDotEnv(dir, "github", { GITHUB_WEBHOOK_SECRET: "s" });
      expect(r.written).toContain("GITHUB_WEBHOOK_SECRET");
      expect(await readFile(join(secrets, ".env"), "utf8")).toContain("GITHUB_WEBHOOK_SECRET=s");
      // Nothing lands at the workspace default — the write and the leak protection target ONE dir.
      expect(existsSync(join(dir, ".secrets", ".env"))).toBe(false);
      // …and the protection travels with the FILE, not the directory: the operator's 0755 dir is left as
      // they set it, while the `.env` this call created is 0600, so the override cannot move
      // `GITHUB_WEBHOOK_SECRET` out of protection.
      expect(((await stat(secrets)).mode & 0o777).toString(8)).toBe("755"); // untouched
      expect(((await stat(join(secrets, ".env"))).mode & 0o777).toString(8)).toBe("600");
    } finally {
      delete process.env.FASTAGENT_SECRETS_DIR;
    }
  });

  it("re-applies 0600 to a `.env` it did not create — `cp .env.example .env` leaves a 0644 one", async () => {
    // The documented copy (and the `replacedInPlace` branch below assumes it) produces a world-readable file, and
    // `mode` on a write is ignored once the file exists. Without re-applying it, a minted GITHUB_WEBHOOK_SECRET
    // lands as plaintext in a 0644 file — the gap the old directory 0700 used to hide.
    const dir = await mkdtemp(join(tmpdir(), "fa-env-copied-"));
    const env = join(dir, ".secrets", ".env");
    await mkdir(dirname(env), { recursive: true });
    await writeFile(env, "# copied from .env.example\n");
    await chmod(env, 0o644);

    await appendChannelDotEnv(dir, "github", { GITHUB_WEBHOOK_SECRET: "topsecret" });

    expect(await readFile(env, "utf8")).toContain("GITHUB_WEBHOOK_SECRET=topsecret");
    expect(((await stat(env)).mode & 0o777).toString(8)).toBe("600");

    // And again with NOTHING to write: every variable is already set, so a condition on "did this call write"
    // would leave the file open forever. Tightening is about the file's contents, not about this run's diff.
    await chmod(env, 0o644);
    const second = await appendChannelDotEnv(dir, "github", { GITHUB_WEBHOOK_SECRET: "topsecret" });
    expect(second.written).toEqual([]);
    expect(((await stat(env)).mode & 0o777).toString(8)).toBe("600");
  });

  it("a SYMLINKED .env is written through but not chmod-ed, and the credential lands either way", async () => {
    // The target is a file the operator placed elsewhere (a shared `app.env`); changing its mode could cut off
    // whatever else reads it, and this call sits past an irreversible boundary — the minted secret must land.
    const dir = await mkdtemp(join(tmpdir(), "fa-env-link-"));
    const shared = join(await mkdtemp(join(tmpdir(), "fa-env-shared-")), "app.env");
    await writeFile(shared, "");
    await chmod(shared, 0o644);
    await mkdir(join(dir, ".secrets"), { recursive: true });
    await symlink(shared, join(dir, ".secrets", ".env"));

    await appendChannelDotEnv(dir, "github", { GITHUB_WEBHOOK_SECRET: "topsecret" });

    expect(await readFile(shared, "utf8")).toContain("GITHUB_WEBHOOK_SECRET=topsecret");
    expect(((await stat(shared)).mode & 0o777).toString(8)).toBe("644"); // the operator's mode, untouched
  });

  it("keeps existing values by default; overwrite names replace stale lines IN PLACE (fresh credentials must not lose)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-env-"));
    await mkdir(join(dir, ".secrets"), { recursive: true });
    await writeFile(join(dir, ".secrets", ".env"), "LARK_APP_ID=cli_old\nLARK_APP_SECRET=old_secret\n");

    // Default: existing non-empty values win, the new ones are dropped as alreadySet.
    let r = await appendChannelDotEnv(dir, "lark", { LARK_APP_ID: "cli_new", LARK_APP_SECRET: "s2" });
    expect(r.alreadySet).toEqual(expect.arrayContaining(["LARK_APP_ID", "LARK_APP_SECRET"]));
    expect(await readFile(join(dir, ".secrets", ".env"), "utf8")).toContain("LARK_APP_ID=cli_old");

    // Overwrite: `add feishu`'s create flow just minted these — the stale line loses, in place (no duplicate
    // assignment that last-wins would then shadow).
    r = await appendChannelDotEnv(dir, "lark", { LARK_APP_ID: "cli_new", LARK_APP_SECRET: "s2" }, [
      "LARK_APP_ID",
      "LARK_APP_SECRET",
    ]);
    expect(r.written).toEqual(expect.arrayContaining(["LARK_APP_ID", "LARK_APP_SECRET"]));
    const content = await readFile(join(dir, ".secrets", ".env"), "utf8");
    expect(content).toContain("LARK_APP_ID=cli_new");
    expect(content).toContain("LARK_APP_SECRET=s2");
    expect(content).not.toContain("cli_old");
    expect(content.match(/^LARK_APP_ID=/gm)?.length).toBe(1);
  });

  it("persists irreversible Feishu credentials in stages so an interrupted bootstrap can resume", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-env-staged-"));
    await mkdir(join(dir, ".secrets"), { recursive: true });
    await writeFile(join(dir, ".secrets", ".env"), "FEISHU_VERIFICATION_TOKEN=stale-other-app-token\n");

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
    const interrupted = await readFile(join(dir, ".secrets", ".env"), "utf8");
    expect(interrupted).toContain("FEISHU_APP_ID=cli_new");
    expect(interrupted).toContain("FEISHU_APP_SECRET=one-time-secret");
    expect(interrupted).not.toContain("stale-other-app-token");
    expect(interrupted).not.toContain("FEISHU_VERIFICATION_TOKEN=token-1");

    await appendChannelDotEnv(dir, "feishu", { FEISHU_VERIFICATION_TOKEN: "token-1" }, ["FEISHU_VERIFICATION_TOKEN"]);
    const completed = await readFile(join(dir, ".secrets", ".env"), "utf8");
    expect(completed).toContain("FEISHU_APP_ID=cli_new");
    expect(completed).toContain("FEISHU_APP_SECRET=one-time-secret");
    expect(completed).toContain("FEISHU_VERIFICATION_TOKEN=token-1");
    expect(completed.match(/^FEISHU_APP_ID=/gm)?.length).toBe(1);
    expect(completed.match(/^FEISHU_VERIFICATION_TOKEN=/gm)?.length).toBe(1);
  });
});
