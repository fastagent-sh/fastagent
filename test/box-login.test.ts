import { describe, expect, it, vi } from "vitest";
import { boxLoginCommand } from "../src/deploy/container.ts";
import { catchingRedirect } from "../src/cli/box-login.ts";
import type { LoginIO } from "../src/harnesses/models/login.ts";
import { createServer as createNetServer } from "node:net";
import type { AddressInfo } from "node:net";

describe("the box half of `login --deployment`", () => {
  it("refuses a value it could not pass to the box's shell verbatim", () => {
    expect(() => boxLoginCommand(["codex'; rm -rf /"])).toThrow(/cannot pass/);
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
      const answer = io.prompt("paste the redirect URL", { redirect: true });
      const page = await fetch(`http://127.0.0.1:${port}/auth/callback?code=abc&state=s`);
      expect(page.status).toBe(200);
      expect(await answer).toBe(`http://localhost:${port}/auth/callback?code=abc&state=s`);
      expect(terminal.aborted()).toBe(true);
      // Caught once: the listener is gone, so nothing else on this port is ours to answer.
      await expect(fetch(`http://127.0.0.1:${port}/auth/callback?code=again`)).rejects.toMatchObject({
        cause: { code: "ECONNREFUSED" },
      });
    } finally {
      io.close();
    }
  });

  it("a question that is not the redirect goes to the person, even with the port listening", async () => {
    const port = await freePort();
    const io = catchingRedirect({ ...waitingTerminal().io, prompt: async () => "acme.ghe.com" });
    try {
      io.openUrl(authUrl(port));
      await fetch(`http://127.0.0.1:${port}/auth/callback?code=early&state=s`);
      expect(await io.prompt("GitHub Enterprise domain (blank for github.com)")).toBe("acme.ghe.com");
      expect(await io.prompt("paste", { redirect: true })).toMatch(/code=early/);
    } finally {
      io.close();
    }
  });

  it("only the flow's own state is taken: a forged hit gets a 404 and the port stays open for the real one", async () => {
    // Any page open in the browser can request a loopback URL. Taken as the answer, it would end the login in pi's
    // "State mismatch" and close the port before the real redirect arrives.
    const port = await freePort();
    const terminal = waitingTerminal();
    const io = catchingRedirect(terminal.io);
    try {
      io.openUrl(authUrl(port));
      const answer = io.prompt("paste the redirect URL", { redirect: true });
      for (const forged of ["code=x", "code=x&state=guessed"]) {
        expect((await fetch(`http://127.0.0.1:${port}/auth/callback?${forged}`)).status, forged).toBe(404);
      }
      expect((await fetch(`http://127.0.0.1:${port}/auth/callback?code=real&state=s`)).status).toBe(200);
      expect(await answer).toMatch(/code=real&state=s$/);
    } finally {
      io.close();
    }
  });

  it("an authorization URL with no state catches nothing: the paste is the way in", async () => {
    const port = await freePort();
    const io = catchingRedirect({ ...waitingTerminal().io, prompt: async () => "pasted" });
    io.openUrl(`https://auth.example/authorize?redirect_uri=${encodeURIComponent(`http://localhost:${port}/cb`)}`);
    await expect(fetch(`http://127.0.0.1:${port}/cb?code=x`)).rejects.toMatchObject({
      cause: { code: "ECONNREFUSED" },
    }); // nothing listens
    expect(await io.prompt("paste", { redirect: true })).toBe("pasted");
    io.close();
  });

  it("a browser that returns before the prompt is asked still answers it", async () => {
    const port = await freePort();
    const io = catchingRedirect(waitingTerminal().io);
    try {
      io.openUrl(authUrl(port));
      await fetch(`http://127.0.0.1:${port}/auth/callback?code=early&state=s`);
      expect(await io.prompt("paste", { redirect: true })).toMatch(/code=early/);
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
      expect(await io.prompt("paste", { redirect: true })).toBe(terminal.pasted);
    } finally {
      io.close();
      taken.close();
    }
  });

  it("a URL with no localhost redirect (a device-code page) catches nothing", async () => {
    const io = catchingRedirect({ ...waitingTerminal().io, prompt: async () => "typed" });
    io.openUrl("https://github.com/login/device");
    expect(await io.prompt("code", { redirect: true })).toBe("typed");
    io.close();
  });
});
