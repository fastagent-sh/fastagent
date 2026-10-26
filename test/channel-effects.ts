import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { TurnEvent } from "../src/channels/kit/invoke-turn-kit.ts";
import { eventStream } from "../src/channels/kit/event-stream.ts";
import type { PortFailure } from "../src/effect-port.ts";

export const run = <A>(work: Effect.Effect<A, PortFailure, Scope.Scope>): Promise<A> =>
  Effect.runPromise(Effect.scoped(work).pipe(Effect.mapError((error) => error.cause)));

export const stream = (events: AsyncIterable<TurnEvent>) => eventStream(() => events, "[test]").pipe(Stream.scoped);
