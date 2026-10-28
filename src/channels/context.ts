/**
 * What a channel is handed when it is mounted (channel.ts): the Agent, a directory of its own, the sessions its
 * conversations talk in, and its turns. Every mount builds a channel's context here, so a channel file, a first-party
 * channel and a test mount the same way.
 */
import { isAbsolute, join } from "node:path";
import type { Agent } from "../agent-api.ts";
import type { ChannelContext } from "../channel.ts";
import { conversationSessions, forkedSession } from "../conversation-sessions.ts";
import { portJoin } from "../effect-port.ts";
import { ensureStateHome } from "../state-file.ts";
import { createTurnQueue } from "./turn-queue.ts";

/** The context of the channel `name` (its file's name under `src/channels/`), its state under `stateRoot`. */
export function channelContext(agent: Agent, stateRoot: string, name: string): ChannelContext {
  if (!isAbsolute(stateRoot)) throw new Error(`a channel's state root must be absolute, got "${stateRoot}"`);
  const stateDir = join(stateRoot, "channels", name);
  ensureStateHome(stateDir);
  const sessions = conversationSessions(join(stateDir, "sessions.json"));
  const turns = createTurnQueue<{ conversation: string; work: () => Promise<void> }>({
    label: `[${name}]`,
    run: ({ work }) => portJoin(work),
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
  };
}
