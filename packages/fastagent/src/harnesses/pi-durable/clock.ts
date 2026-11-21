/**
 * The instance's clock state (schedule/clock.ts) as Session documents of its storage: each schedule's fires, when each
 * was first armed, and the schedules' sessions. Lives where the instance's sessions live (SQLite or PostgreSQL).
 */
import type { Context } from "@earendil-works/chord/context";
import { type JsonObject, type Session, type Tx, defineDoc, defineDocFamily } from "@earendil-works/pi-durable";
import type { Change, ClockStore } from "../../schedule/clock.ts";

const whole = () => true;

type Stored = JsonObject;

const FIRES_KIND = "fastagent.schedule-fires";
const ARMED_KIND = "fastagent.schedule-armed";

const FiresDoc = defineDocFamily<{ fires: Stored[] }, null>({
  kind: FIRES_KIND,
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ fires: [] }),
  checkpointWhen: whole,
});

const ScheduleSessionsDoc = defineDoc<{ sessions: Record<string, string> }>({
  kind: "fastagent.schedule-sessions",
  version: 1,
  scope: "session",
  initial: () => ({ sessions: {} }),
  checkpointWhen: whole,
});

const ArmedDoc = defineDoc<{ armed: Record<string, string> }>({
  kind: ARMED_KIND,
  version: 1,
  scope: "session",
  initial: () => ({ armed: {} }),
  checkpointWhen: whole,
});

/** The document kinds whose commits can move when the clock next fires. */
export const CLOCK_DOC_KINDS: ReadonlySet<string> = new Set([FIRES_KIND, ARMED_KIND]);

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export type ClockSession = Pick<Session, "commit" | "snapshot">;

export function clockStore(session: ClockSession, context: Context): ClockStore {
  const over =
    <D extends JsonObject>(open: (tx: Tx) => Promise<D>, field: keyof D) =>
    <S, T>(change: Change<S, T>): Promise<T> =>
      session.commit(async (tx) => {
        const doc = await open(tx);
        const { next, result } = change(copy(doc[field]) as S);
        if (next !== undefined) (doc as Record<keyof D, unknown>)[field] = copy(next);
        return result;
      }, context);
  const sessions = over((tx) => tx.doc(ScheduleSessionsDoc), "sessions");
  const armed = over((tx) => tx.doc(ArmedDoc), "armed");
  return {
    fires: (name, change) => over((tx) => tx.doc(FiresDoc, name, null), "fires")(change),
    sessions: (change) => sessions(change),
    armed: (change) => armed(change),
    stored: {
      fires: async (name) => copy((await session.snapshot(FiresDoc, name, context))?.fires ?? []) as never,
      sessions: async () => copy((await session.snapshot(ScheduleSessionsDoc, context))?.sessions ?? {}),
      armed: async () => copy((await session.snapshot(ArmedDoc, context))?.armed ?? {}),
    },
  };
}
