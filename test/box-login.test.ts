import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { boxLoginCommand } from "../src/deploy/container.ts";
import { relayLogin } from "../src/cli/login-relay.ts";
import { loginOnBox } from "../src/cli/box-login.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

/** A storage root laid out as a deployed box's (`<root>/base/<agent>`), and a bin dir for the `fastagent` on PATH. */
async function box(): Promise<{ root: string; agentDir: string; bin: string }> {
  const root = await mkdtemp(join(tmpdir(), "fa-box-"));
  const agentDir = join(root, "base", "fastagent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "fastagent.config.ts"), "export default {};\n");
  const bin = join(root, "bin");
  await mkdir(bin);
  return { root, agentDir, bin };
}

async function executable(path: string, body: string): Promise<void> {
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
}

/** Run the box command the way a host shell would: `sh -c <command>`, with the box's environment. */
function onBox(command: string, env: NodeJS.ProcessEnv) {
  const child = spawn("sh", ["-c", command], { env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  return { child, stderr: () => stderr };
}

const envFor = (root: string, bin: string): NodeJS.ProcessEnv => {
  const { FASTAGENT_SECRETS_DIR: _s, FASTAGENT_AUTH_PATH: _a, ...rest } = process.env;
  return { ...rest, PATH: `${bin}:/usr/bin:/bin`, FASTAGENT_STORAGE_DIR: root };
};

describe("the box half of `login --deployment`", () => {
  it("runs in the server's agent dir, with the server's credential path, through the CLI the server runs", async () => {
    const { root, agentDir, bin } = await box();
    await executable(join(bin, "fastagent"), `echo "global $PWD $FASTAGENT_SECRETS_DIR $*"`);
    const run = async () => {
      const { child } = onBox(boxLoginCommand("fastagent", ["codex", "--if-missing"]), envFor(root, bin));
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      await new Promise((resolve) => child.on("close", resolve));
      return out.trim();
    };
    expect(await run()).toBe(`global ${agentDir} ${root}/.secrets login --stdio codex --if-missing`);

    // An agent with its own install runs that one, as the server does…
    await mkdir(join(agentDir, "node_modules", ".bin"), { recursive: true });
    await executable(join(agentDir, "node_modules", ".bin", "fastagent"), `echo "local $*"`);
    expect(await run()).toBe("local login --stdio codex --if-missing");
    // …under Bun when the image is Bun's.
    await executable(join(bin, "bun"), `echo "bun $*"`);
    expect(await run()).toBe("bun run fastagent login --stdio codex --if-missing");
  });

  it("refuses a value it could not pass to the box's shell verbatim", () => {
    expect(() => boxLoginCommand("fastagent", ["codex'; rm -rf /"])).toThrow(/cannot pass/);
  });

  it("reports a credential the box already holds, and a missing one without asking, as one result line", async () => {
    const { root, bin } = await box();
    await executable(join(bin, "fastagent"), `exec "${process.execPath}" "${CLI}" "$@"`);
    const relay = async (args: string[]) => {
      const { child, stderr } = onBox(boxLoginCommand("fastagent", args), envFor(root, bin));
      const noQuestions = {
        select: async () => {
          throw new Error("asked");
        },
        prompt: async () => {
          throw new Error("asked");
        },
        note: () => {},
        openUrl: () => {},
      };
      const result = await relayLogin(child.stdout, child.stdin, noQuestions, () => {});
      const code = await new Promise((resolve) => child.on("close", resolve));
      return { result, code, stderr: stderr() };
    };

    const missing = await relay(["openai-codex", "--if-missing", "--no-input"]);
    expect(missing.result, missing.stderr).toMatchObject({ ok: false, reason: "missing" });
    expect(missing.code).toBe(1);

    await mkdir(join(root, ".secrets"), { recursive: true });
    const oauth = { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000 };
    await writeFile(join(root, ".secrets", "auth.json"), JSON.stringify({ "openai-codex": oauth }));
    const held = await relay(["openai-codex", "--if-missing", "--no-input"]);
    expect(held.result, held.stderr).toEqual({
      ok: true,
      provider: "openai-codex",
      method: "oauth",
      path: join(root, ".secrets", "auth.json"),
      stored: true,
    });
    expect(held.code).toBe(0);
  });

  it("a host CLI that is not installed is named, not waited on", async () => {
    const { root, agentDir } = await box();
    const failed = await loginOnBox({
      host: "fly",
      shell: { bin: "fastagent-test-no-such-cli", args: (command) => ["-c", command] },
      placement: { agentDir, workspace: root },
      input: false,
    });
    expect(failed).toMatch(/could not run fastagent-test-no-such-cli/);
  });

  it("a shell that ends without the result line is a failure, whatever its exit code", async () => {
    const { root, agentDir } = await box();
    const failed = await loginOnBox({
      host: "railway",
      shell: { bin: "sh", args: () => ["-c", "echo Connection closed; exit 0"] },
      placement: { agentDir, workspace: root },
      input: false,
    });
    expect(failed).toMatch(/ended without a login result \(exit 0\).*login --deployment railway/);
  });
});
