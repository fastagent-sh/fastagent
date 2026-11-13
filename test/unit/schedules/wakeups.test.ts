import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { listWakeups } from "../../../src/schedule/wakeups.ts";
import { wakeExtension } from "../../../src/harnesses/pi-durable/wake.ts";

const root = (): Promise<string> => mkdtemp(join(tmpdir(), "fa-wake-"));
const NOW = new Date("2026-07-07T12:00:00Z");
/**
 * The wake tool over `stateRoot`, run as in conversation 1 of storage "inc" (session "inc.1"), or in a conversation a
 * task owns (a subagent's), which is no session.
 */
const wake = (stateRoot: string, params: unknown, owned = false, ticking?: () => boolean) => {
  const tool = wakeExtension(stateRoot, { now: () => NOW, ...(ticking ? { ticking } : {}) }).tools?.find(
    ({ name }) => name === "wake",
  ) as ToolRegistration;
  const api = {
    conversationId: 1,
    snapshot: async () => ({ incarnation: "inc" }),
    commit: async (change: (tx: unknown) => unknown) =>
      change({ conversation: async (id: number) => ({ id, ...(owned ? { owner: { taskId: 5 } } : {}) }) }),
  };
  return tool.execute(params as never, api as never, {} as never);
};

describe("schedule/wake-tool", () => {
  it("the wake tool records a wake-up into the CURRENT session", async () => {
    const r = await root();
    await wake(r, { in: "30m", prompt: "resume the check" });
    expect(listWakeups(r)).toHaveLength(1);
    expect(listWakeups(r)[0]).toMatchObject({ session: "inc.1", prompt: "resume the check" });
  });
});
