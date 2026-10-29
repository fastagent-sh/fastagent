/**
 * What an app's setup says to the person setting it up, for the steps only they can take. At a terminal it is printed,
 * and the page opened. In a coding agent's run it goes to the ticket the agent hands its person (ticket.ts): the step
 * the run waits on as `need_user_action`, and a step left to them after it as `afterwards`.
 */
import { openExternalUrl } from "../open-url.ts";

export interface Person {
  /** A step this run waits on: `instructions`, at `url`. */
  waitsOn(url: string, instructions: string): void;
  /** The step waited on is done: the run carries on without the person. */
  carriesOn(): void;
  /** A step left to the person once this run ends, which nothing here waits for; at `url`, when it has one. */
  afterwards(instructions: string, url?: string): void;
}

/** The person at this terminal: told, and the page opened for them. */
export const terminalPerson: Person = {
  waitsOn(url, instructions) {
    console.error(`[fastagent] ${instructions} — opening ${url} (waiting; keep this running)`);
    openExternalUrl(url);
  },
  carriesOn() {},
  afterwards(instructions, url) {
    if (url === undefined) {
      console.error(`[fastagent] ${instructions}`);
      return;
    }
    console.error(`[fastagent] ${instructions} — opening ${url}`);
    openExternalUrl(url);
  },
};
