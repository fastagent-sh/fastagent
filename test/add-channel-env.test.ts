import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendChannelDotEnv } from "../src/scaffold/add-channel.ts";

describe("appendChannelDotEnv", () => {
  it("keeps existing values by default; overwrite names replace stale lines IN PLACE (fresh credentials must not lose)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fa-env-"));
    await writeFile(join(dir, ".env"), "LARK_APP_ID=cli_old\nLARK_APP_SECRET=old_secret\n");

    // Default: existing non-empty values win, the new ones are dropped as alreadySet.
    let r = await appendChannelDotEnv(dir, "lark", { LARK_APP_ID: "cli_new", LARK_APP_SECRET: "s2" });
    expect(r.alreadySet).toEqual(expect.arrayContaining(["LARK_APP_ID", "LARK_APP_SECRET"]));
    expect(await readFile(join(dir, ".env"), "utf8")).toContain("LARK_APP_ID=cli_old");

    // Overwrite: `add feishu`'s create flow just minted these — the stale line loses, in place (no duplicate
    // assignment that last-wins would then shadow).
    r = await appendChannelDotEnv(dir, "lark", { LARK_APP_ID: "cli_new", LARK_APP_SECRET: "s2" }, [
      "LARK_APP_ID",
      "LARK_APP_SECRET",
    ]);
    expect(r.written).toEqual(expect.arrayContaining(["LARK_APP_ID", "LARK_APP_SECRET"]));
    const content = await readFile(join(dir, ".env"), "utf8");
    expect(content).toContain("LARK_APP_ID=cli_new");
    expect(content).toContain("LARK_APP_SECRET=s2");
    expect(content).not.toContain("cli_old");
    expect(content.match(/^LARK_APP_ID=/gm)?.length).toBe(1);
  });
});
