/**
 * `defineChannel` — a channel file's authoring surface, and the third member of the `defineX` family
 * (with `defineTool` / `defineSchedule`). Its whole job is the secrets: a channel is the one code
 * input that is ALL credentials (a bot token, a signing secret), and before this it read them from
 * `process.env` at module scope, which meant a CUSTOM channel could not tell `deploy` what to carry —
 * the deploy could only guess from a table of first-party names.
 *
 * The declaration attaches to the module WITHOUT adding a third module form to the Channel contract
 * (channel.ts §7 fixes two: a function is a route channel, an object with `connect` is a long
 * connection). The builder runs at import and returns one of those two; the declared names ride along
 * as a property that the discovery reads and everything else ignores.
 *
 * Values are read at import, so a rotated credential needs a restart — the same lifetime an adapter
 * configured with a literal already has, and the reason there is no per-request accessor here.
 *
 * KNOWN GAP: every declared name is REQUIRED (the gate refuses an empty value), so an
 * OPTIONAL credential has no expression here — declare it and an agent that does not use it cannot
 * start; leave it out and `deploy` does not carry it. First-party channels have the third answer in
 * the scaffold table (`ChannelEnv.required`), which is why feishu/lark still read their optional
 * `*_ENCRYPT_KEY` from the environment. Closing it means a second entry shape here
 * (`{ name, required: false }`) carried through `DeclaredSecret`, `missingSecrets` and the deploy
 * runbook's required flag — a contract change, not a local one.
 */
import type { ChannelModule, LongConnectionChannelModule } from "../channel.ts";
import { secretValues } from "../declared-secrets.ts";

/** A channel module carrying what it declared it needs. Read by discovery; ignored by the server. */
type DeclaringChannelModule<M> = M & { secrets?: readonly string[] };

export interface DefineChannelOptions<S extends readonly string[], M> {
  /**
   * Env vars this channel needs (`["TELEGRAM_BOT_TOKEN"]`), typed into `channel`. `deploy` carries
   * them to the host and `dev`/`start` refuse to serve while one is unset, naming this file.
   */
  secrets?: S;
  /** Build the channel from those values — usually one call to an adapter (`telegramChannel({...})`). */
  channel: (secrets: Record<S[number], string>) => M;
}

// `S` defaults to the EMPTY tuple for the same reason as `defineTool`: a channel that declares
// nothing must not type-check `secrets.ANYTHING`.
export function defineChannel<
  const S extends readonly string[] = readonly [],
  M extends ChannelModule | LongConnectionChannelModule = ChannelModule,
>(options: DefineChannelOptions<S, M>): DeclaringChannelModule<M> {
  const built = options.channel(secretValues(options.secrets));
  // Object.assign on a FUNCTION module keeps it a function (the route-channel form); on the
  // long-connection object it adds one field. Either way the shape the server sees is unchanged.
  return Object.assign(built, options.secrets ? { secrets: options.secrets } : {}) as DeclaringChannelModule<M>;
}
