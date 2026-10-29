import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import type { AuthInteraction, Credential, Provider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loginFlow } from "../src/harnesses/models/login.ts";
import { LoginNeedsAnswer, type LoginNotice, scriptedLoginIO } from "../src/cli/scripted-login.ts";

afterEach(() => vi.restoreAllMocks());

/** A provider whose key sign-in asks a choice, a project and the key, as Vertex's does. */
const gateway = {
  id: "gw",
  name: "Gateway",
  getModels: () => [],
  auth: {
    apiKey: {
      name: "Gateway key",
      resolve: async () => undefined,
      login: async (interaction: AuthInteraction): Promise<Credential> => {
        const region = await interaction.prompt({
          type: "select",
          message: "Region",
          options: [
            { id: "eu", label: "Europe" },
            { id: "us", label: "United States" },
          ],
        });
        const project = await interaction.prompt({ type: "text", message: "Project" });
        const key = await interaction.prompt({ type: "secret", message: "Enter Gateway key" });
        return { type: "api_key", key, env: { REGION: region, PROJECT: project } };
      },
    },
  },
} as unknown as Provider;

const authFile = async () => join(await mkdtemp(join(tmpdir(), "fa-scripted-")), "auth.json");

describe("login without a terminal", () => {
  it("answers each question the sign-in asks with the next line of stdin, a choice by its id or label", async () => {
    for (const region of ["us", "United States"]) {
      const authPath = await authFile();
      const io = scriptedLoginIO(Readable.from([`${region}\nacme\nsk-1\n`]), () => {});
      await loginFlow(io, { authPath, providers: [gateway], provider: "gw", menus: false });
      expect(JSON.parse(await readFile(authPath, "utf8")).gw).toEqual({
        type: "api_key",
        key: "sk-1",
        env: { REGION: "us", PROJECT: "acme" },
      });
    }
  });

  it("refuses a question stdin has no line for, or no choice of, naming what it asks", async () => {
    const authPath = await authFile();
    const asked = (input: string) =>
      loginFlow(
        scriptedLoginIO(Readable.from([input]), () => {}),
        {
          authPath,
          providers: [gateway],
          provider: "gw",
          menus: false,
        },
      );
    await expect(asked("eu\nacme\n")).rejects.toThrow(
      new LoginNeedsAnswer('the sign-in asks "Enter Gateway key": pass the answer on stdin, one line per question'),
    );
    await expect(asked("mars\n")).rejects.toThrow('"mars" answers no choice of "Region": eu, us');
    await expect(asked("")).rejects.toThrow('the sign-in asks "Region": answer on stdin with one of eu, us');
  });

  it("waits for a browser's callback past the end of stdin, and takes the code from stdin when one comes", async () => {
    const ended = scriptedLoginIO(Readable.from([]), () => {});
    const callback = new AbortController();
    const waiting = ended.prompt("Paste the redirect URL", { manual: true, signal: callback.signal });
    const settled = vi.fn();
    void waiting.then(settled);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).not.toHaveBeenCalled();
    callback.abort();
    expect(await waiting).toBeUndefined();

    const input = new PassThrough();
    const pasted = scriptedLoginIO(input, () => {}).prompt("Paste the redirect URL", {
      manual: true,
      signal: new AbortController().signal,
    });
    input.end("http://localhost:1455/auth/callback?code=c\n");
    expect(await pasted).toBe("http://localhost:1455/auth/callback?code=c");
  });

  it("a line arriving after a prompt was withdrawn answers the next question, not the withdrawn one", async () => {
    const input = new PassThrough();
    const io = scriptedLoginIO(input, () => {});
    const withdrawn = new AbortController();
    const manual = io.prompt("Paste the redirect URL", { manual: true, signal: withdrawn.signal });
    withdrawn.abort();
    expect(await manual).toBeUndefined();
    const next = io.prompt("Project");
    input.end("acme\n");
    expect(await next).toBe("acme");
  });

  it("hands what a person would read to its caller: the notes, and the address to open", () => {
    const said: LoginNotice[] = [];
    const io = scriptedLoginIO(Readable.from([]), (notice) => said.push(notice));
    io.note("Open this URL to authorize");
    io.openUrl("https://auth.example/authorize");
    expect(said).toEqual([
      { type: "note", message: "Open this URL to authorize" },
      { type: "open", url: "https://auth.example/authorize" },
    ]);
  });
});
