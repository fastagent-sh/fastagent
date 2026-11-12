import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalAgent } from "../src/harnesses/pi-durable/serve.ts";
import { fauxAgent } from "./cli-run.ts";
import { openSource } from "./open-source.ts";

export const scratch: string[] = [];

export const agents: LocalAgent[] = [];

export async function directory(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

export async function open(options: Parameters<typeof openSource>[1] & { dir?: string } = {}): Promise<LocalAgent> {
  const { dir = await fauxAgent("fa-open-inputs-"), ...rest } = options;
  const agent = await openSource(dir, { secrets: {}, env: {}, ...rest });
  agents.push(agent);
  return agent;
}

export const BOTH_WAYS = `export default {
  kind: "fastagent.by-ingress",
  webhook: () => ({ "POST /both": () => new Response("webhook") }),
  connection: {
    name: "both",
    connect: (_ctx, signal) => ({
      ready: Promise.resolve(),
      closed: new Promise((resolve) => signal.addEventListener("abort", resolve)),
    }),
  },
};
`;
