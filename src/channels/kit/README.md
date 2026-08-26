Shared machinery for writing a channel — the parts every chat platform needs and none of them should
reinvent: durable turn intent, un-summoned-discussion buffers, per-session serial turns, delivery
dedup, live-preview rendering, participant tracking.

Each file here has consumers only under `channels/<platform>/`. The serving mechanism next door
(`serve.ts`, `http.ts`, `control.ts`, `discover.ts`) has the opposite property: no platform imports it.
