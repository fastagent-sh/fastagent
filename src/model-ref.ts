/** Model selection syntax shared by a local definition and a remote Caller, without loading a harness. */
import type { ModelRef } from "./agent-api.ts";

export function modelRefOf(spec: string, where: string): ModelRef {
  const slash = typeof spec === "string" ? spec.indexOf("/") : -1;
  if (slash < 1 || slash === spec.length - 1) {
    throw new Error(`${where} must be "provider/modelId", got ${JSON.stringify(spec)}`);
  }
  return { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) };
}
