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
  const value = process.env.FASTAGENT_ENGINE;
  if (value === undefined || value === "") return "harness";
  if (value === "harness" || value === "session") return value;
  // A typo picking the default engine is how someone spends an afternoon wondering why their switch
  // did nothing.
  throw new Error(`FASTAGENT_ENGINE must be "harness" or "session" (got ${JSON.stringify(value)})`);
}
