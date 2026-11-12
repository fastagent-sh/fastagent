import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SendRequest } from "../src/agent-api.ts";
import type { TurnEvent } from "../src/channels/kit/invoke-turn-kit.ts";
import { scriptedAgent } from "./scripted-agent.ts";
import { readFires } from "../src/schedule/state.ts";

export const NOW = new Date("2026-07-07T10:30:00Z");

export const hourly = (name = "job") => ({ name, cron: "0 * * * *", tz: "UTC", prompt: "go" });

export const freshRoot = () => mkdtemp(join(tmpdir(), "fa-scheduler-effects-"));

/**
 * Seed a HEALTHY prior fire: the slot's claim, stamped with when it was taken AND with the outcome the turn wrote
 * back. Without the outcome the boot reconciler would report the claim as `interrupted`, which is a different test.
 */
export function seedFiredSlots(stateRoot: string, names: string[], firedAt: string, slot = firedAt): void {
  for (const name of names) {
    const dir = join(stateRoot, "schedule", "claims", name);
    mkdirSync(dir, { recursive: true });
    // Through `toISOString` first: a claim file name is the shape `claimSlot` writes, and nothing else is read as one.
    const record = JSON.stringify({ firedAt, outcome: "completed", ms: 1 });
    writeFileSync(join(dir, new Date(slot).toISOString().replace(/[:.]/g, "-")), record);
  }
}

/** How this state root says each fire of `name` ended — `undefined` = claimed, never settled. */
export const outcomes = (stateRoot: string, name = "job"): (string | undefined)[] =>
  readFires(stateRoot, name).map((f) => f.outcome);

/** When a state root says this schedule last fired — the claim, read the way the scheduler reads it. */
export const lastFire = (stateRoot: string, name: string): string | undefined =>
  readFires(stateRoot, name).at(-1)?.firedAt;

/** An agent that runs `script` for each message it is sent; `sent` lists each message's session. */
export const agentRunning = (script: (request: SendRequest) => AsyncIterable<TurnEvent>) => {
  const agent = scriptedAgent(script);
  return { agent, sent: () => agent.sent.map((request) => request.sessionId) };
};
