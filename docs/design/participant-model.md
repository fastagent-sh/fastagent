---
title: Participant model
description: "How a FastAgent bot behaves inside a collaboration tool (Feishu/Lark, Slack): the participant axiom, the three rules derived from it, and the session/placement/summon mapping that follows."
type: design-doc
status: current
updated: 2026-07-25
---

# Participant model

This document defines the interaction model for chat channels in collaboration tools — who the bot
answers, where the answer appears, and what it remembers. It is the *why* behind the routing and
session code in `src/channels/feishu/`, `src/channels/slack/`, and `src/channels/telegram/`; the
mechanisms themselves are documented in [core.md](core.md).

The model is derived, not assembled. Everything below follows from one axiom, so changing the axiom
invalidates the rules rather than adjusting them.

## 1. The axiom

A bot in a collaboration tool can be framed two ways:

| | Participant (a colleague) | Endpoint (a command surface) |
|---|---|---|
| Identity | a member of the room | an API |
| Invocation | addressed by name | called with a request |
| Memory | remembers the room | each request independent |
| Output | where it was asked | a return value |

**Most bots are built as endpoints; every user perceives them as participants.** That mismatch is the
root cause of the recurring complaints: "why must I @ it inside a thread we are already in", "why did
it forget what I said a minute ago", "why did its answer show up somewhere else".

> **Axiom: the agent is a participant in the room. Its interaction rules are derived from how people
> behave in that room, not from the mechanics of sessions.**

An author can still build an endpoint-shaped bot by supplying an explicit `route`; the *defaults*
implement the participant.

## 2. Listening is not speaking

The first consequence, and the one most bot designs miss:

> A participant hears everything said in the room, and speaks only when addressed.

The two capabilities are independent, and FastAgent implements them separately: everything heard but
not addressed to the agent is buffered as context (`channels/context-buffer.ts`) and folded into the
next answered turn in that place; speaking is governed by rule 1 below.

This is also what the platform's sensitive group-message scope actually buys. It does not grant the
right to speak — it grants the ability to *hear*. Without it the agent is a colleague who only opens
its eyes when called by name: usable, but slow-witted. The permission therefore selects a posture
rather than a feature:

| Posture | Permission | Experience |
|---|---|---|
| Present participant | group-message scope granted | hears context, answers with it |
| Summoned tool | mention-only | sees only what is addressed to it |

## 3. Rule 1 — when to speak

People address each other by name in a crowd, and drop the name when a conversation has only two
sides. The rule is therefore about the *conversation*, not about the chat type:

> **Speak without being addressed if, and only if, the agent is a participant of this place and this
> place has exactly one human participant. Otherwise require an explicit mention.**

Direct messages are not a special case — they are the instance of the rule where the place has one
human. The derived behavior:

| Place | Humans | Behavior |
|---|---|---|
| Direct message | 1 | always answer |
| Group main timeline | many | require @mention |
| Thread with one human | 1 | answer bare messages |
| Thread with several humans | many | require @mention, keep listening |

The last row is the part that "answer everything in a thread the agent once joined" gets wrong: a
colleague who keeps answering every sentence of a three-way discussion because they were asked one
question is behaving badly. The agent must fall back to listening when the conversation stops being
a two-party exchange.

**Participation** is required so the agent does not barge into a human thread it was never part of.
The agent is a participant of a thread once it has answered in it. Bootstrapping is therefore the
ordinary social move: mention it once inside the thread, and it stops needing to be named. (A thread's
root message lives in the main timeline, not in the thread, so the root is not what establishes
participation.)

**Mentioning only other people is not addressing the agent.** Such a message is discussion; it is
buffered, never answered.

## 4. Rule 2 — where to speak

People answer where they were asked, because that is where the audience is. Moving the answer
elsewhere without saying so is the behavior of a bad colleague.

> **Answer in the place the question was asked. Never relocate an answer silently.**

| Asked in | Answered in |
|---|---|
| Main timeline | main timeline, quoting the question |
| Thread | that thread |
| Direct message | the direct message |

The agent does not open threads on its own. Automatic placement requires a heuristic ("is this a long
task?"), and an unpredictable answer location is worse than an untidy timeline. A human who wants a
side conversation opens a thread, and the agent follows them into it.

*Non-goal, deliberately deferred:* relocating a long-running task into a thread to release the main
timeline's turn lock. It is defensible only if announced in place, and only with a reliable
"this will take a while" signal. People already open threads for long work.

## 5. Rule 3 — what to remember

People in a room share a memory of that room; entering a side conversation does not erase it; and
what a side conversation concludes gets carried back.

> **Memory follows the place. A room has one memory. A thread starts from what the room knew and
> keeps its own history. What happens in a thread flows back to the room.**

| Place | Session | Rationale |
|---|---|---|
| Direct message | one continuous session per chat | a colleague does not restart every message |
| Group main timeline | one session per chat, shared by everyone | B following up on A's question is the normal case, and the agent must remember its own answers |
| Thread | one session per thread, anchored to what it branched from | a side conversation is separate, not amnesiac |
| Thread → room | conclusions fold upward (§7) | "we decided X in that thread" |

Sessions are **per place, never per person**. A room's conversation belongs to the room: scoping
memory per user would break the most common collaborative pattern (one person following up on
another's exchange) and would hide the agent's own answers from everyone but the asker.

## 6. Concurrency follows the same rule

The unit of concurrency is the session, and the session is the place. This is not a technical
compromise — it is the same social rule:

- one conversation is sequential: people take turns, and an answer may depend on the previous one;
- separate conversations are parallel: threads proceed independently.

Two turns in one place must therefore serialize (`channels/turn-queue.ts` FIFO, and the engine's
single-writer lease in `engines/pi/invoke.ts`). Two turns in different places run concurrently
because they are different sessions.

Finer-grained concurrency (parallel turns *inside* one session, branching the session tree per turn)
is rejected: a conversation needs convergence, and a tree only provides divergence. Concatenating two
independently computed turns afterwards is a stale read — harmless when the two asks are causally
independent, silently wrong when the second refers to the first, and there is no way to tell them
apart without understanding the content. The user already tells us which asks are independent: by
opening a thread.

## 7. Upward fold: what a thread tells the room

A side conversation loses two different things, and they have asymmetric costs:

| Loss | Who suffers | Cost of fixing automatically |
|---|---|---|
| The room's session does not contain the thread's content | the agent (amnesiac when back in the room) | **none** — nobody sees it |
| The people in the room do not know the thread's outcome | other humans | **high** — a message in the main timeline |

> **Memory folds automatically; attention must be requested explicitly.**

**Memory fold (automatic).** When a turn in a thread completes, it records that thread's *latest*
exchange into the room's pending-fold state, keyed by thread and **overwritten** each time. The
room's next turn folds those records into its prompt and clears them on `completed` — the same
peek → completed → commit invariant the context buffer already uses, and the same generic mechanism
(`channels/context-buffer.ts`).

Keying by thread with overwrite makes the state **O(threads), not O(turns)**, so it needs no pruning
policy, and the newest exchange is what a side discussion's conclusion usually is. The fold carries
the agent's own reply as well as the human's message: a participant remembers what it said.

No summarization model call: the fold is truncated verbatim. If a single latest exchange proves
insufficient, the upgrade path is a summary (pi exposes `generateBranchSummary`), not more history.

**Attention fold (explicit).** A person in the thread asks the agent to share the outcome, and the
agent posts to the main timeline using its send capability. This requires no new mechanism — but it
does require the send tool to state its boundary, or the agent will use it to answer ordinary turns
and double-post. Slack's native "also send to channel" on a thread reply is the same idea provided by
the platform, and is preferable where it exists.

## 8. Thread context: the inheritance ladder

A thread must start from something. Four rungs, increasing in cost:

| Rung | Mechanism | Gives the thread |
|---|---|---|
| 1 | referent anchor, truncated | the followed-up message, cut at 560 code points |
| **2** | **referent anchor, generously bounded** | **the followed-up message in full (4000 code points)** |
| 3 | seed injection | the room's last N exchanges, in the thread's first prompt |
| 4 | session fork | the room's entire history, reasoning and tool results included |

Rung 1 fails the model's own main path: following up on the agent's answer, where the answer is
routinely longer than the cut. **Rung 2 is implemented.** The anchor is loaded for the FIRST message of
a thread — the one that points at something outside it — and skipped afterwards, since later messages
reply to what the thread's own session already holds. An unreadable referent degrades to a marker in
the prompt: context is not the ask, and losing it must not cost the answer. Rung 3 is the next
increment if anchors prove too narrow.

Rung 4 (`SessionRepo.fork`, which would need an optional lineage field on `Scope`) is **not planned**:
it over-delivers by copying the whole room — including everyone's unrelated conversations — into a
focused side discussion, and it pays that cost on every turn rather than once. Its only exclusive
capability is preserving the agent's reasoning and tool results; that is worth revisiting when a real
case appears, not before.

*Known asymmetry, accepted:* room → thread transfers once, when the thread starts; thread → room
folds continuously (§7). A thread does not learn about later room activity.

## 9. Rejected designs

| Rejected | Why |
|---|---|
| A new session per ask | a colleague with anterograde amnesia |
| A session per user in a room | the room's conversation belongs to the room, not to each speaker |
| Automatic thread creation | unpredictable answer location; needs a heuristic |
| "Smart" answer placement | turns a deterministic question into a guessing game |
| Answering every bare message in a joined thread | barges into multi-human discussion |
| Per-entry concurrency inside a session | divergence without convergence; stale reads |
| Automatic summaries posted to the room | attention has a noise cost, so it needs consent |

## 10. Mapping to platforms

The model is platform-neutral; the primitives differ in strength.

| Capability | Feishu / Lark | Slack |
|---|---|---|
| Side conversation | topic (`thread_id` + `root_id`) | thread (`thread_ts`) |
| Hearing the room | sensitive group-message scope | channel message events |
| Attention fold | agent posts a message | native "also send to channel" |
| Dedicated direct surface | ordinary p2p chat | assistant pane |

## 11. Scope

Implemented for Feishu/Lark. Slack and Telegram still carry the earlier per-ask session model and its
`directMessageSession` / `groupMessageSession` options; converging them is follow-up work, and the
rules above are the target for both.

## 12. Migration

The participant model replaces the earlier `threaded` / `continuous` mode pair. Those two options
coupled three independent axes — session identity, reply placement, and the summon rule — so a user
who wanted room-level sessions was forced to also give up mention-free thread continuations. The
model above sets each axis on its own principle, which leaves nothing for the modes to select.

Breaking changes for existing deployments:

- direct messages become one continuous conversation instead of one session per top-level message;
- group summons answer in place instead of opening a thread;
- threads answer bare messages only while a single human is in them.
