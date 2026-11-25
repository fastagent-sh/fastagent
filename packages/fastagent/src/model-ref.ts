/** Model selection syntax shared by a local definition and a remote Caller, without loading a harness. */
import { type ModelRef, parseModelRef } from "@fastagent-sh/client/agent-api";

export function modelRefOf(spec: string, where: string): ModelRef {
  const parsed = parseModelRef(spec);
  if (parsed === undefined) {
    throw new Error(`${where} must be "provider/modelId", got ${JSON.stringify(spec)}`);
  }
  return parsed;
}
