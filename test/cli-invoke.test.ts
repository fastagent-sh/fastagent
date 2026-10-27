import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it } from "vitest";
import { openLockedStorage } from "../src/harnesses/pi-durable/storage.ts";
import { resolveStateRoot } from "../src/paths.ts";
import { fauxAgent as agent, killWhileLingering, lingered, run, whileServed } from "./cli-run.ts";

/** The session id an invoke printed on stderr. */
function sessionOf(stderr: string): string {
  const id = /\[fastagent\] session (\S+) \(continue it with --session \1\)/.exec(stderr)?.[1];
  if (id === undefined) throw new Error(`no session id in: ${stderr}`);
  return id;
}

describe("cli: invoke", () => {
  it("--session continues the session an earlier run printed, beside a serve, and --json prints its events", async () => {
    const dir = await agent("fa-invoke-session-");
    const sessionId = await whileServed(dir, async () => {
      const first = await run(["invoke", "hello", dir]);
      expect([first.code, first.stdout.trim()], first.stderr).toEqual([0, "seen 1"]);
      const sessionId = sessionOf(first.stderr);
      const second = await run(["invoke", "--session", sessionId, "again", dir]);
      expect([second.code, second.stdout.trim(), sessionOf(second.stderr)], second.stderr).toEqual([
        0,
        "seen 2",
        sessionId,
      ]);
      // A continued session answers with the model this run names.
      const switched = await run(["invoke", "--session", sessionId, "--model", "gw/m2", "and", dir]);
      expect(switched.stdout.trim(), switched.stderr).toBe("seen 3 by m2");
      // Without --session, a run is a session of its own.
      const fresh = await run(["invoke", "hello", dir]);
      expect([fresh.stdout.trim(), sessionOf(fresh.stderr) === sessionId]).toEqual(["seen 1", false]);
      return sessionId;
    });

    const json = await run(["invoke", "--session", sessionId, "--json", "use a tool", dir]);
    expect(json.code, json.stderr).toBe(0);
    const lines = json.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; name?: string; message?: { status?: string } });
    expect(lines[0]).toMatchObject({ type: "message", message: { sessionId } });
    expect(lines.find((line) => line.type === "tool_started")).toMatchObject({ name: "read" });
    expect(lines.at(-1)).toMatchObject({ type: "done", message: { status: "completed" } });
  });

  it("ends the message a killed invoke left, so no later invoke runs it again", async () => {
    const dir = await agent("fa-invoke-killed-");
    await killWhileLingering(["invoke", "linger, then deploy to prod", dir], dir);
    const next = await run(["invoke", "hello", dir]);
    expect([next.code, next.stdout.trim()], next.stderr).toEqual([0, "seen 1"]);
    expect(next.stderr).toMatch(/aborted 1 message\(s\) an earlier process accepted and stopped before they ended/);
    expect((await run(["invoke", "hello again", dir])).stderr).not.toContain("aborted");
    expect(await lingered(dir)).toBe(1);
  });

  it("refuses a session it does not hold, and runs while no other invoke of the agent does", async () => {
    const dir = await agent("fa-invoke-refused-");
    const unknown = await run(["invoke", "--session", "nope", "hello", dir]);
    expect([unknown.code, unknown.stdout]).toEqual([1, ""]);
    expect(unknown.stderr).toMatch(/--session nope: no such session in .*invoke\.sqlite/);

    const held = await openLockedStorage(join(resolveStateRoot(dir), "invoke.sqlite"), "posix", "the test");
    try {
      const busy = await run(["invoke", "hello", dir]);
      expect(busy.code).toBe(1);
      expect(busy.stderr).toContain("another `fastagent invoke` of this agent is running");
    } finally {
      await held.close(BACKGROUND_CONTEXT);
    }
  });
});
