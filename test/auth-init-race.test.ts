/**
 * The first-write init race (deterministic): the pre-lock existence check can go stale when another
 * process creates and fills the file in between. The init write is an EXCLUSIVE create precisely so
 * that stale check can never clobber the other process's credentials; this simulates the stale
 * check by mocking existsSync to report the file missing once while it really exists.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { staleExists } = vi.hoisted(() => ({ staleExists: { path: "", armed: false } }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (p: unknown) => {
      if (staleExists.armed && p === staleExists.path) {
        staleExists.armed = false;
        return false; // the stale observation: "file does not exist" while it already does
      }
      return actual.existsSync(p as Parameters<typeof actual.existsSync>[0]);
    },
  };
});

import { fastagentCredentialStore } from "../src/harnesses/pi/auth.ts";

describe("first-write init race (stale existence check simulated)", () => {
  it("exclusive create refuses to clobber a file another process already initialized", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-auth-race-"));
    const path = join(dir, "auth.json");
    const existing = { anthropic: { type: "api_key", key: "ka" } };
    await writeFile(path, JSON.stringify(existing));

    staleExists.path = path;
    staleExists.armed = true;
    await fastagentCredentialStore(path).modify("openai", async () => ({ type: "api_key", key: "kb" }));

    const creds = JSON.parse(await readFile(path, "utf8"));
    expect(Object.keys(creds).sort()).toEqual(["anthropic", "openai"]);
    expect(creds.anthropic).toEqual(existing.anthropic); // the concurrent first write survived
  });
});
