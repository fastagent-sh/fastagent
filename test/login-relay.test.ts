import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { AuthInteraction, Credential, Provider } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { type IoOption, type LoginIO, loginFlow } from "../src/harnesses/pi/login.ts";
import { relayLogin, stdioLoginIO } from "../src/cli/login-relay.ts";

const OAUTH: Credential = { type: "oauth", access: "tok", refresh: "rt", expires: Date.now() + 3_600_000 };

/**
 * A browser OAuth flow as it runs on a box: it announces the URL, then only a pasted redirect can finish it (the
 * box's own callback server is never reached from the owner's browser).
 */
const boxOauth: Provider = {
  id: "codex",
  name: "codex",
  getModels: () => [],
  auth: {
    oauth: {
      name: "codex (OAuth)",
      login: async (cb: AuthInteraction) => {
        cb.notify({ type: "auth_url", url: "https://auth.example/authorize" });
        const pasted = await cb.prompt({ type: "manual_code", message: "Paste the redirect URL" });
        if (pasted !== "http://localhost:1455/cb?code=abc") throw new Error(`unexpected ${pasted}`);
        return OAUTH;
      },
    },
  },
} as unknown as Provider;

/** The owner's terminal, scripted: what it was shown and opened, and the answers it gives. */
function terminal(answers: { select?: string[]; prompt?: Array<string | undefined> }) {
  const shown: { notes: string[]; opened: string[]; selects: IoOption[][]; prompts: string[] } = {
    notes: [],
    opened: [],
    selects: [],
    prompts: [],
  };
  const io: LoginIO = {
    select: async (_m, options) => {
      shown.selects.push(options);
      return answers.select?.shift();
    },
    prompt: async (message) => {
      shown.prompts.push(message);
      return answers.prompt?.shift();
    },
    note: (m) => void shown.notes.push(m),
    openUrl: (u) => void shown.opened.push(u),
  };
  return { io, shown };
}

/** Wire the two halves together the way a host shell does: box stdout → terminal, terminal answers → box stdin. */
function session() {
  const toBox = new PassThrough();
  const fromBox = new PassThrough();
  return { box: stdioLoginIO(toBox, fromBox), toBox, fromBox };
}

describe("login relay", () => {
  it("a login on the box is driven from the terminal: URL opened there, redirect pasted back, result reported", async () => {
    const { box, toBox, fromBox } = session();
    const { io, shown } = terminal({ prompt: ["http://localhost:1455/cb?code=abc"] });
    const relayed = relayLogin(fromBox, toBox, io, () => {});
    const authPath = join(await mkdtemp(join(tmpdir(), "fa-relay-")), "auth.json");
    const result = await loginFlow(box.io, { authPath, provider: "codex", providers: [boxOauth] });
    box.result({ ok: true, provider: result.provider, method: result.method, path: authPath });
    fromBox.end();
    expect(await relayed).toEqual({ ok: true, provider: "codex", method: "oauth", path: authPath });
    expect(shown.opened).toEqual(["https://auth.example/authorize"]);
    expect(shown.prompts).toEqual(["Paste the redirect URL"]);
    expect(JSON.parse(await readFile(authPath, "utf8")).codex.type).toBe("oauth");
  });

  it("a select is answered by value, and backing out reaches the box as undefined", async () => {
    const { box, toBox, fromBox } = session();
    const { io, shown } = terminal({ select: ["b"], prompt: [undefined] });
    void relayLogin(fromBox, toBox, io, () => {});
    const options = [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
    ];
    expect(await box.io.select("pick", options)).toBe("b");
    expect(shown.selects).toEqual([options]);
    expect(await box.io.prompt("key", { hidden: true })).toBeUndefined();
  });

  it("a prompt the box withdraws is cancelled in the terminal and never answered", async () => {
    const { box, toBox, fromBox } = session();
    let terminalSignal: AbortSignal | undefined;
    const io: LoginIO = {
      ...terminal({}).io,
      prompt: (_m, opts) =>
        new Promise((resolve) => {
          terminalSignal = opts?.signal;
          opts?.signal?.addEventListener("abort", () => resolve(undefined));
        }),
    };
    const answers: string[] = [];
    toBox.on("data", (chunk) => answers.push(String(chunk)));
    void relayLogin(fromBox, toBox, io, () => {});
    const withdraw = new AbortController();
    const asked = box.io.prompt("paste", { signal: withdraw.signal });
    await vi.waitFor(() => expect(terminalSignal).toBeDefined());
    withdraw.abort();
    expect(await asked).toBeUndefined();
    await vi.waitFor(() => expect(terminalSignal?.aborted).toBe(true));
    expect(answers).toEqual([]);
  });

  it("a session that ends without a result line reports none, whatever else it printed", async () => {
    const { toBox, fromBox } = session();
    const passed: string[] = [];
    const relayed = relayLogin(fromBox, toBox, terminal({}).io, (line) => passed.push(line));
    fromBox.end("Connecting to fdaa:0:1::2...\n{not the wire}\nConnection closed\n");
    expect(await relayed).toBeUndefined();
    expect(passed).toEqual(["Connecting to fdaa:0:1::2...", "{not the wire}", "Connection closed"]);
  });

  it("the box stops waiting once the terminal side goes away: pending and later questions read as backed out", async () => {
    const { box, toBox } = session();
    const pending = box.io.select("pick", [{ value: "a", label: "A" }]);
    toBox.end();
    expect(await pending).toBeUndefined();
    expect(await box.io.prompt("again")).toBeUndefined();
  });
});
