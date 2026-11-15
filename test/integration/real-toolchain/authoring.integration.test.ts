import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAndOpen } from "./authoring-fixtures.ts";

describe("a scaffolded agent", () => {
  it("opens without npm install", async () => {
    // Its configuration imports only a type, which Node strips: nothing of the package is loaded until code needs it.
    const base = await mkdtemp(join(tmpdir(), "fa-authoring-"));
    expect(await createAndOpen(join(base, "plain"))).toBe("opened");
  });
});
