import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendChannelDotEnv,
  appendChannelEnv,
  channelSetup,
  scaffoldChannel,
  scaffoldCompanionTools,
} from "../src/scaffold/add-channel.ts";
import { FEISHU_AGENT_SCOPES } from "../src/channels/feishu/setup-mode.ts";
import { writeValues } from "../src/value-file.ts";

describe("channel setup guidance", () => {
  it("names every agent permission before the publish step, for both clouds and ingresses", () => {
    for (const kind of ["feishu", "lark"] as const) {
      for (const ingress of ["webhook", "connection"] as const) {
        const steps = channelSetup(kind, ingress).steps;
        const scopeIndex = steps.findIndex((step) => step.includes("im:message.group_msg"));
        const publishIndex = steps.findIndex((step, index) => index > scopeIndex && /publish/i.test(step));
        expect(scopeIndex).toBeGreaterThanOrEqual(0);
        expect(publishIndex).toBeGreaterThan(scopeIndex);
        for (const entry of FEISHU_AGENT_SCOPES) expect(steps[scopeIndex]).toContain(entry.request);
      }
    }
  });

  it("Slack's channel is scaffolded for both ways, and its names are listed for whoever fills them", async () => {
    expect(channelSetup("slack").env.map((entry) => entry.name)).toEqual([
      "SLACK_BOT_TOKEN",
      "SLACK_APP_TOKEN",
      "SLACK_SIGNING_SECRET",
    ]);

    const dir = await mkdtemp(join(tmpdir(), "fa-slack-scaffold-"));
    await scaffoldChannel(dir, "slack");
    // A companion tool from an earlier package version is replaced on re-add; the channel file is not.
    await mkdir(join(dir, "src", "tools"));
    await writeFile(join(dir, "src", "tools", "slack-send.ts"), "// 0.20.0: process.env.SLACK_BOT_TOKEN");
    await scaffoldCompanionTools(dir, "slack");
    const source = await readFile(join(dir, "src", "channels", "slack.ts"), "utf8");
    expect(source).toContain("export default byIngress({");
    expect(source).toContain("slackSocketChannel(");
    expect(source).toContain("slackChannel(");
    expect(source).toContain('rendering: "native"');
    expect(await readFile(join(dir, "src", "tools", "slack-send.ts"), "utf8")).toContain(
      "slackTransport(SLACK_BOT_TOKEN)",
    );
  });

  it("a dev WebSocket app needs only App ID/Secret and leaves production on its own app", async () => {
    const setup = channelSetup("feishu", "connection");
    expect(setup.env.map((entry) => entry.name)).toEqual(["FEISHU_APP_ID", "FEISHU_APP_SECRET"]);
    expect(setup.steps.join("\n")).toContain("a deployment receives by webhook");
    expect(setup.steps.join("\n")).toContain("`deploy --run` creates a separate production app");

    // One channel file, whichever way it receives: each instance's configuration picks the way.
    const dir = await mkdtemp(join(tmpdir(), "fa-feishu-scaffold-"));
    await scaffoldChannel(dir, "feishu");
    const source = await readFile(join(dir, "src", "channels", "feishu.ts"), "utf8");
    expect(source).toContain("export default byIngress({");
    expect(source).toContain("feishuWebSocketChannel(");
    expect(source).toContain("feishuChannel(");
  });
});

describe("appendChannelEnv", () => {
  it("lists every var the channel can declare, so a deployment's values can be filled from it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-env-example-"));
    await mkdir(join(dir, ".secrets"), { recursive: true });
    await writeFile(join(dir, ".secrets", ".env.example"), "# agent\n");
    expect(await appendChannelEnv(dir, "feishu")).toBe(true);
    const example = await readFile(join(dir, ".secrets", ".env.example"), "utf8");
    for (const name of ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_VERIFICATION_TOKEN", "FEISHU_ENCRYPT_KEY"]) {
      expect(example).toContain(`# ${name}=`);
    }
    expect(example).toMatch(/# webhook only \(`start`, every deployment\).*\n# FEISHU_VERIFICATION_TOKEN=/);
  });
});

describe("appendChannelDotEnv", () => {
  it("writes to the RESOLVED secrets dir — FASTAGENT_SECRETS_DIR moves the .env target with the protection", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-env-move-"));
    const secrets = await mkdtemp(join(tmpdir(), "fa-env-external-"));
    await chmod(secrets, 0o755); // an existing dir the operator (or a volume mount) left wide open
    process.env.FASTAGENT_SECRETS_DIR = secrets;
    try {
      const r = await appendChannelDotEnv(dir, "telegram", { TELEGRAM_SECRET_TOKEN: "s" });
      expect(r.written).toContain("TELEGRAM_SECRET_TOKEN");
      expect(await readFile(join(secrets, ".env"), "utf8")).toContain("TELEGRAM_SECRET_TOKEN=s");
      // Nothing lands at the workspace default — the write and the leak protection target ONE dir.
      expect(existsSync(join(dir, ".secrets", ".env"))).toBe(false);
      // …and the protection travels with the FILE, not the directory: the operator's 0755 dir is left as
      // they set it, while the `.env` this call created is 0600, so the override cannot move
      // `TELEGRAM_SECRET_TOKEN` out of protection.
      expect(((await stat(secrets)).mode & 0o777).toString(8)).toBe("755"); // untouched
      expect(((await stat(join(secrets, ".env"))).mode & 0o777).toString(8)).toBe("600");
    } finally {
      delete process.env.FASTAGENT_SECRETS_DIR;
    }
  });

  it("writes to the file it is given, and says so when that file's directory is not one fastagent protects", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-env-file-"));
    const elsewhere = await mkdtemp(join(tmpdir(), "fa-env-elsewhere-"));
    const file = join(elsewhere, "prod.env");
    const result = await writeValues(dir, "slack channel", [{ name: "SLACK_BOT_TOKEN", value: "xoxb-1" }], [], file);
    expect(result.written).toEqual(["SLACK_BOT_TOKEN"]);
    expect(await readFile(file, "utf8")).toContain("SLACK_BOT_TOKEN=xoxb-1");
    expect(existsSync(join(dir, ".secrets", ".env"))).toBe(false);
    // A directory nothing of ours made carries no .gitignore, and fastagent will not write one into it.
    expect(result.unprotectedSecretsDir).toBe(elsewhere);
    expect(((await stat(file)).mode & 0o777).toString(8)).toBe("600");
  });

  it("slots a value under the marker a .env copied from .env.example already has, not at the end of the file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-env-marker-"));
    await mkdir(join(dir, ".secrets"), { recursive: true });
    await writeFile(
      join(dir, ".secrets", ".env"),
      "# mine\nOPENAI_API_KEY=sk-x\n\n# --- telegram channel ---\n# from @BotFather → /newbot\n# TELEGRAM_BOT_TOKEN=\n",
    );
    await appendChannelDotEnv(dir, "telegram", { TELEGRAM_SECRET_TOKEN: "s3cret" });
    const envFile = await readFile(join(dir, ".secrets", ".env"), "utf8");
    expect(envFile).toMatch(/# --- telegram channel ---\nTELEGRAM_SECRET_TOKEN=s3cret\n/);
    // The commented placeholder is mentioned already — not duplicated.
    expect(envFile.match(/TELEGRAM_BOT_TOKEN/g)).toHaveLength(1);
    expect(envFile).toContain("OPENAI_API_KEY=sk-x");
  });

  it("replaces an ACTIVE but EMPTY assignment in place: never shadowed by a line elsewhere (last-wins)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-env-empty-"));
    await mkdir(join(dir, ".secrets"), { recursive: true });
    await writeFile(
      join(dir, ".secrets", ".env"),
      "# --- telegram channel ---\nTELEGRAM_SECRET_TOKEN=\nOPENAI_API_KEY=sk-x\n",
    );
    await appendChannelDotEnv(dir, "telegram", { TELEGRAM_SECRET_TOKEN: "s3cret" });
    const envFile = await readFile(join(dir, ".secrets", ".env"), "utf8");
    expect(envFile.match(/^TELEGRAM_SECRET_TOKEN=/gm)).toHaveLength(1);
    expect(envFile).toContain("TELEGRAM_SECRET_TOKEN=s3cret");
    expect(envFile).toContain("OPENAI_API_KEY=sk-x");
  });

  it("leaves an EXISTING .env's mode alone — creating one is the only time fastagent decides it", async () => {
    // `cp .secrets/.env.example .secrets/.env` produces a 0644 file the operator owns. fastagent appends to it and
    // says nothing about its mode: the rule is "who created the file", and re-deciding this one would be the tool
    // changing permissions on something it did not create. (The case above covers the file it DOES create: 0600.)
    const dir = await mkdtemp(join(tmpdir(), "fa-env-copied-"));
    const env = join(dir, ".secrets", ".env");
    await mkdir(dirname(env), { recursive: true });
    await writeFile(env, "# copied from .env.example\n");
    await chmod(env, 0o644);

    await appendChannelDotEnv(dir, "telegram", { TELEGRAM_SECRET_TOKEN: "topsecret" });

    expect(await readFile(env, "utf8")).toContain("TELEGRAM_SECRET_TOKEN=topsecret");
    expect(((await stat(env)).mode & 0o777).toString(8)).toBe("644");
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
