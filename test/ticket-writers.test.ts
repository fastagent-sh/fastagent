import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A ticket is written by several processes at once (the command that started the step, the step's own process, every
 * `--check`), and `writeFileAtomic`'s fixed temp name is for one writer: two of them rename each other's file away or
 * write one temp at once. That race is in atomic-write.test.ts; this holds ticket.ts to the shared-writers form.
 */
const writes: { path: string; shared: boolean }[] = [];
vi.mock("../src/atomic-write.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/atomic-write.ts")>();
  return {
    ...real,
    writeFileAtomic: (path: string, data: string | Buffer, mode?: number, shared = false) => {
      writes.push({ path, shared });
      real.writeFileAtomic(path, data, mode, shared);
    },
  };
});

afterEach(() => {
  writes.length = 0;
  vi.useRealTimers();
});

describe("a ticket's writers", () => {
  it("each write the ticket file and the address file through a temp of their own", async () => {
    const { checkTicket, createTicket } = await import("../src/cli/ticket.ts");
    const ticket = createTicket({
      subject: "login:openai",
      action: "sign in to OpenAI",
      check: "fastagent login --check",
      restart: "fastagent login openai --method account",
      timeoutSeconds: 60,
    });
    expect(writes.map(({ path }) => path.replace(/^.*\//, ""))).toEqual([`${ticket.ticket}.json`]);
    // `--check --code` hands the address over only to a step waiting on its person, with a process to take it.
    const file = join(process.env.HOME as string, ".fastagent", ".state", "tickets", `${ticket.ticket}.json`);
    writeFileSync(file, JSON.stringify({ ...ticket, status: "need_user_action", pid: process.pid }));
    vi.useFakeTimers();
    const checking = checkTicket(ticket.ticket, "http://localhost:1455/auth/callback?code=x");
    await vi.advanceTimersByTimeAsync(20_000);
    await checking;
    vi.useRealTimers();
    expect(writes.map(({ path }) => path.replace(/^.*\//, ""))).toContain(`${ticket.ticket}.address`);
    expect(writes.filter(({ shared }) => !shared)).toEqual([]);
  });
});
