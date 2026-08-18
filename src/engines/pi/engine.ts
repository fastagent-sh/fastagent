/**
 * Which pi class runs a turn. TEMPORARY, and env-only on purpose.
 *
 * The serving path is moving off `AgentHarness` — pi 0.84 replaced it with an unimplemented skeleton,
 * and pi does not consume that class itself ([conformance-levels.md](../../../docs/design/conformance-levels.md)).
 * `AgentSession` is where it is going; until that path carries the observation plane and persisted
 * tool activation, `harness` stays the default and this switch is how the new one gets exercised
 * against real agents.
 *
 * Not a config field and not a CLI flag: an author choosing an engine is not a decision this product
 * wants to own. It disappears with the harness path.
 */
export type PiEngine = "harness" | "session";

export function piEngine(): PiEngine {
  return process.env.FASTAGENT_ENGINE === "session" ? "session" : "harness";
}
