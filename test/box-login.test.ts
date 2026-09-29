import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { boxLoginCommand } from "../src/deploy/container.ts";
import { relayLogin } from "../src/cli/login-relay.ts";
import { catchingRedirect, loginOnBox } from "../src/cli/box-login.ts";
import { processShell } from "../src/deploy/box-shell.ts";
import type { LoginIO } from "../src/engines/pi/login.ts";
import { createServer as createNetServer } from "node:net";
import type { AddressInfo } from "node:net";

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
    expect(held.result, held.stderr).toEqual({ ok: true, provider: "openai-codex", kept: "OAuth" });
    expect(held.code).toBe(0);
  });

  it("a host CLI that is not installed is named, not waited on", async () => {
    const { root, agentDir } = await box();
    const failed = await loginOnBox({
      host: "fly",
      shell: processShell("fastagent-test-no-such-cli", (command) => ["-c", command], root),
      placement: { agentDir, workspace: root },
      input: false,
    });
    expect(failed).toMatch(/could not run fastagent-test-no-such-cli/);
  });

  it("a shell that ends without the result line is a failure, whatever its exit code", async () => {
    const { root, agentDir } = await box();
    const failed = await loginOnBox({
      host: "railway",
      shell: processShell("sh", () => ["-c", "echo Connection closed; exit 0"], root),
      placement: { agentDir, workspace: root },
      input: false,
    });
    expect(failed).toMatch(/ended without a login result \(exit 0\).*login --deployment railway/);
  });

  it("the command it hands back names the provider the model needs, so no menu offers another", async () => {
    const { root, agentDir } = await box();
    const missing = '{"type":"result","ok":false,"reason":"missing","message":"no openai-codex credential"}';
    const failed = await loginOnBox({
      host: "fly",
      shell: processShell("sh", () => ["-c", `echo '${missing}'`], root),
      placement: { agentDir, workspace: root },
      provider: "openai-codex",
      input: false,
    });
    expect(failed).toBe(
      "not logged in: no openai-codex credential — run `fastagent login openai-codex --deployment fly` in a terminal",
    );
  });
});

/** A free loopback port, released for the code under test to take. */
async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** A terminal whose paste prompt waits until it is aborted, recording what it was told. */
function waitingTerminal() {
  const notes: string[] = [];
  let aborted = false;
  const io: LoginIO = {
    select: async () => undefined,
    prompt: (_m, opts) =>
      new Promise((resolve) =>
        opts?.signal?.addEventListener("abort", () => {
          aborted = true;
          resolve(undefined);
        }),
      ),
    note: (m) => void notes.push(m),
    openUrl: () => {},
  };
  return { io, notes, aborted: () => aborted };
}

const authUrl = (port: number) =>
  `https://auth.example/authorize?redirect_uri=${encodeURIComponent(`http://localhost:${port}/auth/callback`)}&state=s`;

describe("catching the browser's redirect on this machine", () => {
  it("answers the paste prompt with the address the browser came back to, and closes the terminal prompt", async () => {
    const port = await freePort();
    const terminal = waitingTerminal();
    const io = catchingRedirect(terminal.io);
    try {
      io.openUrl(authUrl(port));
      const answer = io.prompt("paste the redirect URL");
      const page = await fetch(`http://127.0.0.1:${port}/auth/callback?code=abc&state=s`);
      expect(page.status).toBe(200);
      expect(await answer).toBe(`http://localhost:${port}/auth/callback?code=abc&state=s`);
      expect(terminal.aborted()).toBe(true);
      // Caught once: the listener is gone, so nothing else on this port is ours to answer.
      await expect(fetch(`http://127.0.0.1:${port}/auth/callback?code=again`)).rejects.toThrow();
    } finally {
      io.close();
    }
  });

  it("a browser that returns before the prompt is asked still answers it", async () => {
    const port = await freePort();
    const io = catchingRedirect(waitingTerminal().io);
    try {
      io.openUrl(authUrl(port));
      await fetch(`http://127.0.0.1:${port}/auth/callback?code=early`);
      expect(await io.prompt("paste")).toMatch(/code=early/);
    } finally {
      io.close();
    }
  });

  it("a taken port says so and leaves the paste prompt as the way in", async () => {
    const taken = createNetServer();
    await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
    const { port } = taken.address() as AddressInfo;
    const terminal = { ...waitingTerminal(), pasted: "http://localhost/pasted?code=p" };
    const io = catchingRedirect({ ...terminal.io, prompt: async () => terminal.pasted });
    try {
      io.openUrl(authUrl(port));
      await vi.waitFor(() => expect(terminal.notes.join("\n")).toMatch(new RegExp(`${port}.*EADDRINUSE.*paste`)));
      expect(await io.prompt("paste")).toBe(terminal.pasted);
    } finally {
      io.close();
      taken.close();
    }
  });

  it("a URL with no localhost redirect (a device-code page) catches nothing", async () => {
    const io = catchingRedirect({ ...waitingTerminal().io, prompt: async () => "typed" });
    io.openUrl("https://github.com/login/device");
    expect(await io.prompt("code")).toBe("typed");
    io.close();
  });
});
