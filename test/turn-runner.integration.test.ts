import { rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dirs, durable } from "./turn-runner-fixtures.ts";

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("turn runner: the lifecycle order every chat channel shares", () => {
  it("SIGTERM preserves the durable state, running or answered", async () => {
    for (const phase of ["running", "committed"]) {
      const { dir, openStore } = durable();
      const source = new URL("../src/channels/kit/", import.meta.url).href;
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
        import { createTurnRunner } from ${JSON.stringify(`${source}turn-runner.ts`)};
        import { portJoin } from ${JSON.stringify(new URL("../src/effect-port.ts", import.meta.url).href)};
        import { createTurnStore } from ${JSON.stringify(`${source}turn-store.ts`)};
        const root = ${JSON.stringify(dir)};
        const store = createTurnStore(root + '/turns.json', { label: '[child]', isRecord: () => true, order: () => 0 });
        const runner = createTurnRunner({
          label: '[child]', store, discussion: async () => ({ text: '', folded: [] }), toStored: r => ({ ...r, attempts: 0 }), fromStored: r => r,
          discussionKey: () => 'place:s', where: () => 'child', onDeferred: () => {}, notifyDropped: () => {},
          deliverAnswer: () => portJoin(async () => {}),
          execute: (_rec, _discussion, onAnswered) => portJoin(async () => {
            process.on('message', () => {
              onAnswered('the answer');
              process.send('answered');
            });
            process.send('running');
            await new Promise(() => {});
          }),
        });
        runner.submit({ id: 'a', conversation: 's', text: '' }, true);
      `,
        ],
        { stdio: ["ignore", "ignore", "pipe", "ipc"] },
      );
      let stderr = "";
      child.stderr?.on("data", (data) => {
        stderr += data;
      });
      const exited = once(child, "exit");
      const message = () =>
        Promise.race([
          once(child, "message").then(([value]) => value),
          exited.then(() => {
            throw new Error(`child exited before the expected message: ${stderr}`);
          }),
        ]);
      try {
        expect(await message(), phase).toBe("running");
        if (phase === "committed") {
          const answered = message();
          child.send("complete");
          expect(await answered, phase).toBe("answered");
        }
      } finally {
        child.kill("SIGTERM");
        await exited;
      }
      // Killed mid-delivery, the answer is on disk to re-deliver; killed mid-run, only the intent is.
      expect(openStore().recover(), phase).toEqual([
        {
          id: "a",
          conversation: "s",
          text: "",
          attempts: 1,
          ...(phase === "committed" ? { answer: "the answer" } : {}),
        },
      ]);
    }
  });
});
