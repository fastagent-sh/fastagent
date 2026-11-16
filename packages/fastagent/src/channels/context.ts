/**
 * What a channel is handed when it is mounted (channel.ts): the Agent, a directory of its own, the sessions its
 * conversations talk in, and its turns. Every mount builds a channel's context here, so an author's channel, a
 * first-party channel and a test mount the same way.
 */
import { isAbsolute, join } from "node:path";
import type { Agent } from "@fastagent-sh/client/agent-api";
import type { ChannelContext } from "@fastagent-sh/client/channel";
import { conversationSessions, forkedSession } from "../conversation-sessions.ts";
import * as Effect from "effect/Effect";
import { originalError, joinPromise } from "@fastagent-sh/client/promise-bridge";
import { log } from "@fastagent-sh/client/log";
import { ensureStateHome } from "@fastagent-sh/client/state-file";
import { beginWork } from "./busy.ts";
import { createTurnQueue } from "@fastagent-sh/client/kit/turn-queue";

/** The directory of the channel `name`'s own state under `stateRoot`: its context's `stateDir`. */
function channelStateDir(stateRoot: string, name: string): string {
  return join(stateRoot, "channels", name);
}

/** The context of the channel `name` (its name in `fastagent.config.ts`), its state under `stateRoot`. */
export function channelContext(agent: Agent, stateRoot: string, name: string): ChannelContext {
  if (!isAbsolute(stateRoot)) throw new Error(`a channel's state root must be absolute, got "${stateRoot}"`);
  const stateDir = channelStateDir(stateRoot, name);
  ensureStateHome(stateDir);
  const sessions = conversationSessions(join(stateDir, "sessions.json"));
  const turns = createTurnQueue<{ conversation: string; work: () => Promise<void> }>({
    label: `[${name}]`,
    beginWork,
    // The channel's own failure surface: `turn` promises a failed one goes to the log, said as the author wrote it.
    run: ({ conversation, work }) =>
      joinPromise(work).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() =>
            log.error(`[${name}] turn failed (place=${conversation}): ${String(originalError(cause))}`),
          ),
        ),
      ),
  });
  return {
    agent,
    stateDir,
    sessionFor: (key, options) => {
      const forkFrom = options?.forkFrom;
      return sessions.of(
        key,
        agent,
        forkFrom === undefined ? undefined : async () => forkedSession(agent, await forkFrom()),
      );
    },
    recordedSession: (key) => sessions.get(key),
    turn: (place, work) => turns.accept({ conversation: place, work }),
    beginWork,
  };
}
