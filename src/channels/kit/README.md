Shared machinery for writing a channel, the parts every chat platform needs: durable turn intent, per-conversation
turn order with steering, delivery dedup, live-preview rendering, participant tracking, the history tool, request
ingress, and what a platform's setup asks of a person.

The kit belongs to the client side (`@fastagent-sh/client/channel` once the workspace is split): it imports only the
contracts and the client side's own helpers, and a channel under `channels/<platform>/` imports only its own directory
and the client side. `test/guards/package-boundary.test.ts` holds both lines. What the process owns (its count of
work in flight, the state root) reaches a channel through its `ChannelContext`.
