/**
 * The instance's clock state (schedule/clock.ts) as Session documents of its storage: each schedule's fires, the
 * pending wake-ups, and the schedules' sessions. So they live where the instance's sessions live, SQLite or
 * PostgreSQL, held by the one process that holds them, and each change is one commit of the Session's.
 *
 * A store is made over a Session's commits and reads: the Session's own for the clock, and a tool call's for `wake`, so
 * the wake-up it sets is stored in that call's commit. A read is a snapshot: one of a document never written is its
 * initial value, and creates nothing.
 */
import type { Context } from "@earendil-works/chord/context";
import { type JsonObject, type Session, type Tx, defineDoc, defineDocFamily } from "@earendil-works/pi-durable";
import type { Change, ClockStore } from "../../schedule/clock.ts";

/** Each value is stored whole, as a base: it is small, and replaced by every change. */
const whole = () => true;

/** A fire or a wake-up, as JSON: the clock's own types are its readers'. */
type Stored = JsonObject;

const FiresDoc = defineDocFamily<{ fires: Stored[] }, null>({
  kind: "fastagent.schedule-fires",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ fires: [] }),
  checkpointWhen: whole,
});

const WakeupsDoc = defineDoc<{ wakeups: Stored[] }>({
  kind: "fastagent.wakeups",
  version: 1,
  scope: "session",
  initial: () => ({ wakeups: [] }),
  checkpointWhen: whole,
});

const ScheduleSessionsDoc = defineDoc<{ sessions: Record<string, string> }>({
  kind: "fastagent.schedule-sessions",
  version: 1,
  scope: "session",
  initial: () => ({ sessions: {} }),
  checkpointWhen: whole,
});

/** A detached copy: what a change reads is not the draft it may replace. */
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** What a store needs of a Session, or of a tool call (its `api`). */
export type ClockSession = Pick<Session, "commit" | "snapshot">;

/** The clock's state in `session`: each change reads and writes its document in one commit, each read snapshots it. */
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
  const wakeups = over((tx) => tx.doc(WakeupsDoc), "wakeups");
  const sessions = over((tx) => tx.doc(ScheduleSessionsDoc), "sessions");
  return {
    fires: (name, change) => over((tx) => tx.doc(FiresDoc, name, null), "fires")(change),
    wakeups: (change) => wakeups(change),
    sessions: (change) => sessions(change),
    stored: {
      fires: async (name) => copy((await session.snapshot(FiresDoc, name, context))?.fires ?? []) as never,
      wakeups: async () => copy((await session.snapshot(WakeupsDoc, context))?.wakeups ?? []) as never,
      sessions: async () => copy((await session.snapshot(ScheduleSessionsDoc, context))?.sessions ?? {}),
    },
  };
}
