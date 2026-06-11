import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piOAuthAuth } from "../src/index.ts";

// AuthResolver's param is deliberately just { provider } (interface segregation) — no Model cast needed.
const model = { provider: "anthropic" };

afterEach(() => vi.restoreAllMocks());

describe("piOAuthAuth (silent-failure discipline)", () => {
  it("missing file → undefined, no warning (normal not-configured)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const auth = await piOAuthAuth("/nonexistent/auth.json")(model);
    expect(auth).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("corrupt JSON → undefined, but warns (diagnosable root cause)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-auth-"));
    const path = join(dir, "auth.json");
    await writeFile(path, "{not valid json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const auth = await piOAuthAuth(path)(model);
    expect(auth).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("corrupt auth file"));
  });

  it("注入 warn sink → 告警走注入的 logger，不碰 console", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-auth-"));
    const path = join(dir, "auth.json");
    await writeFile(path, "{not valid json");
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const messages: string[] = [];

    const auth = await piOAuthAuth(path, { warn: (m) => messages.push(m) })(model);

    expect(auth).toBeUndefined();
    expect(messages[0]).toContain("corrupt auth file");
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it("valid oauth cred → access token as apiKey; expired → undefined", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-auth-"));
    const path = join(dir, "auth.json");
    await writeFile(
      path,
      JSON.stringify({
        anthropic: { type: "oauth", access: "tok-live", expires: Date.now() + 60_000 },
      }),
    );
    expect(await piOAuthAuth(path)(model)).toEqual({ apiKey: "tok-live" });

    await writeFile(
      path,
      JSON.stringify({ anthropic: { type: "oauth", access: "tok-old", expires: Date.now() - 1 } }),
    );
    expect(await piOAuthAuth(path)(model)).toBeUndefined();
  });
});
