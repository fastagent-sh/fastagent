/**
 * Internal serving facade re-exporting harness loading (`harness-loader.ts`), scoped instance lifecycle
 * (`instance-lifecycle.ts`), and the `openAgent` embedding wrapper (`local-agent.ts`).
 */
export { resolveHarnessProvider } from "./harness-loader.ts";
export {
  type OpenServingOptions,
  type OpenedServing,
  type ServingAgent,
  describeInstanceStorage,
  openServing,
} from "./instance-lifecycle.ts";
export { type LocalAgent, type OpenAgentOptions, openAgent } from "./local-agent.ts";
