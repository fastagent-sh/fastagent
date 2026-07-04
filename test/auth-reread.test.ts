import { describe, expect, it, vi } from "vitest";

// node:fs is mocked for the WHOLE file (so it is isolated from auth.test.ts, which uses real files):
// readFileSync returns a controllable sequence so a transient torn read (empty / half-written) can be
// exercised deterministically, without relying on an actual sub-millisecond write race.
const { reads } = vi.hoisted(() => ({ reads: [] as string[] }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: () => reads.shift() ?? "{}", existsSync: () => true };
});

import { fastagentCredentialStore } from "../src/index.ts";

describe("fastagentCredentialStore.read: torn-read recovery", () => {
  it("re-reads a transient empty/partial file until it yields the credential (no warn, no degrade)", async () => {
    const cred = { type: "oauth", access: "tok", refresh: "r", expires: Date.now() + 60_000 };
    const complete = JSON.stringify({ anthropic: cred });
    for (const torn of ["", '{"anthropic":{"type":"oa']) {
      reads.length = 0;
      reads.push(torn, complete); // first read sees the torn write; the re-read sees the full file
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(await fastagentCredentialStore("/x/auth.json").read("anthropic")).toEqual(cred);
      expect(warn).not.toHaveBeenCalled(); // recovered — not spuriously warned or read as not-configured
      warn.mockRestore();
    }
  });
});
