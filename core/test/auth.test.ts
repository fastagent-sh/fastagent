import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piOAuthAuth, probeAuthSource } from "../src/index.ts";

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

  it("injected warn sink routes warnings to the injected logger without touching console", async () => {
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

  it("valid oauth credential returns access token as apiKey; expired credential returns undefined with warning instead of silently degrading", async () => {
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
    const messages: string[] = [];
    expect(await piOAuthAuth(path, { warn: (m) => messages.push(m) })(model)).toBeUndefined();
    expect(messages[0]).toContain("expired"); // root cause surfaced, not buried under "missing API key"
  });
});

describe("probeAuthSource (startup credential report; dev + start)", () => {
  it("reports oauth when the credentials file has a live token for the provider", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-probe-"));
    const path = join(dir, "auth.json");
    await writeFile(path, JSON.stringify({ anthropic: { type: "oauth", access: "tok", expires: Date.now() + 60_000 } }));
    expect(await probeAuthSource("anthropic", path)).toBe("oauth");
  });

  it("reports none when neither the credentials file nor env provides a key", async () => {
    // a provider with no env-var mapping + a nonexistent auth file → deterministically none
    expect(await probeAuthSource("no-such-provider", "/nonexistent/auth.json")).toBe("none");
  });
});
