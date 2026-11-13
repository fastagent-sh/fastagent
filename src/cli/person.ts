/**
 * What an app's setup says to the person setting it up, for the steps only they can take. In a coding agent's run it
 * goes to the ticket the agent hands its person (ticket.ts): the step the run waits on as `need_user_action`, and a
 * step left to them after it as `afterwards`.
 */
export interface Person {
  /** A step this run waits on: `instructions`, at `url`; `until`, when the step itself lapses (ms since the epoch). */
  waitsOn(url: string, instructions: string, until?: number): void;
  /** The step waited on is done: the run carries on without the person. */
  carriesOn(): void;
  /** A step left to the person once this run ends, which nothing here waits for; at `url`, when it has one. */
  afterwards(instructions: string, url?: string): void;
}
