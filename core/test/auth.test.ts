import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { piOAuthAuth } from "../src/index.ts";

const model = { provider: "anthropic" } as Model<any>;

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
