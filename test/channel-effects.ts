import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { AgentEvent } from "../src/agent.ts";
import { eventStream } from "../src/channels/kit/event-stream.ts";
import type { TaskFailure } from "../src/channels/kit/tasks.ts";

export const run = <A>(work: Effect.Effect<A, TaskFailure, Scope.Scope>): Promise<A> =>
  Effect.runPromise(Effect.scoped(work).pipe(Effect.mapError((error) => error.cause)));

export const stream = (events: AsyncIterable<AgentEvent>) => eventStream(() => events, "[test]").pipe(Stream.scoped);
