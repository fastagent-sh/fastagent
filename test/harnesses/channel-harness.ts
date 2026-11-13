/**
 * Shared test harness for platform channel suites (Telegram, Slack, Feishu): scripted reply agent,
 * mid-flight fetch settle heuristic, and deterministic turn-queue drain + temp-root cleanup.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { type Asked, type Prompt, asked, promptOf, scriptedAgent } from "../doubles/scripted-agent.ts";
import { ev } from "../doubles/scripted-run.ts";

export function replyingAgent(reply = "") {
  const calls: Asked[] = [];
  const prompts: Prompt[] = [];
  const agent = scriptedAgent(async function* (request) {
    yield ev.message();
    calls.push(asked(request));
    prompts.push(promptOf(request));
    if (reply !== "") yield ev.text(reply);
    yield ev.ended();
  });
  return { agent, calls, prompts };
}

/**
 * Settle async up to where the fetch-call count stops changing. Intra-test only for observing
 * mid-flight side effects; cross-test cleanup relies on `drainAndClean()`.
 */
export async function flushFetchMock(): Promise<void> {
  const f = globalThis.fetch as unknown as { mock?: { calls: unknown[] } };
  let prev = -1;
  for (let i = 0; i < 100 && (f.mock?.calls.length ?? 0) !== prev; i++) {
    prev = f.mock?.calls.length ?? 0;
    await new Promise((r) => setImmediate(r));
  }
}

export function createChannelSandbox(prefix: string) {
  const roots: string[] = [];
  const idles = new Set<() => Promise<void>>();

  const freshRoot = (): string => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    roots.push(dir);
    return dir;
  };

  const trackIdle = (handler: unknown): (() => Promise<void>) => {
    const idle = (handler as { turnsIdle?: () => Promise<void> }).turnsIdle;
    if (idle) idles.add(idle);
    return idle ?? (async () => {});
  };

  const settle = async (): Promise<void> => {
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.all([...idles].map((idle) => idle()));
  };

  const drainAndClean = async (): Promise<void> => {
    vi.useRealTimers();
    await Promise.race([Promise.all([...idles].map((idle) => idle())), new Promise((r) => setTimeout(r, 2000))]);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    idles.clear();
    for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  };

  return { freshRoot, trackIdle, settle, drainAndClean };
}
