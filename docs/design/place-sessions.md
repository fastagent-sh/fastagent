---
title: Place sessions
description: "How a chat channel maps a place onto Agent sessions: one trunk per place that holds its memory, branches forked from it so the place never waits behind one exchange, and the place-history fold that brings what the branches said back to the trunk."
type: design-doc
status: proposed
updated: 2026-11-09
---

# Place sessions

**Status: proposed (#989). Not implemented.** It replaces [participant-model.md](participant-model.md) Rule 3
(what to remember) and §6 (concurrency). The participant axiom, Rule 1 (when to speak) and Rule 2 (where to speak)
stay as they are. Nothing here changes the [Agent API](../SPEC.md).

A channel maps each place to one session today, and that one session does three jobs at once: it holds the place's
memory, it is the place's only runner, and it is what people in the place talk to. Every current problem with
channel interaction comes from that coupling:

- One person's long task holds every other ask in the group behind it.
- A correction sent while the agent works waits until the work ends.
- A thread forks from its room, and nothing comes back: the room never learns what the thread concluded
  (participant-model §7).
- On Slack, an Agent DM starts a new session for every top-level message, so the agent forgets the person's previous
  conversation (participant-model §11).

This document keeps the memory where it is, in one session per place, and moves concurrency into sessions forked from
it.

## 1. What a session is

FastAgent's session is a pi-durable conversation. It is made of four things:

| Part | What it is | Property |
|---|---|---|
| Record | An append-only log of immutable entries | Complete and durable. Nothing in it is ever changed |
| Projection | What the model sees: the newest `head` marker and the entries after it, with `edits` applied | Bounded by the context window. Compaction and reset append a new head; the record stays |
| Runner | One run at a time. Input that arrives meanwhile waits in an inbox, as a steer (placed after the current tool round) or a follow-up (placed when the run ends) | The source of serialization |
| Lineage | A fork records its parent and the entry it forked at, and starts with the parent's history up to there | A session can be forked. It cannot be merged |

So a session is a record, a projection over it, and a runner. Compaction, reset and fork are all operations on the
projection; the record never changes.

Sessions are not a security boundary. The agent's tools reach every session of the instance
([security-boundary.md](security-boundary.md) §3), so how a channel divides a place into sessions is a question of what
the model sees and of who waits for whom, nothing else.

## 2. What memory is

Memory has three layers, and recall moves things into the middle one:

| Layer | What it is | In FastAgent |
|---|---|---|
| Record | Everything that happened. Complete, and expensive to read whole | The session's log; the platform's history of the place ([place-history.md](place-history.md): "the platform is the place's memory") |
| Working memory | What the model sees in one run. Bounded, and lossy under compaction | The session's projection |
| Distilled memory | What the agent wrote down to keep | The agent's own files |

## 3. What a channel has to decide

A place produces one shared record: everything people and the agent said there. A channel has two decisions to make
over it:

- **Projection**: what each run of the model sees of that record.
- **Scheduling**: which runs may proceed at the same time, and who waits for whom.

A sender's identity matters in only two ways: to label who said what in a projection, and as a signal of whether a
message continues an exchange that is already going on. One session per place makes both decisions at the size of the
whole place. This design makes them per exchange, and keeps one session per place as the place's memory.

## 4. The fold, as it works today

The design is built on one mechanism channels already have, so it is described first.

When the agent is asked something in a place, the channel does not send the ask alone. It puts in front of the ask
what was said in the place since the agent last answered there, and sends both as the one user message of that turn.
This is the **fold** ([place-history.md](place-history.md) §3). A group ask reaches the model like this:

```text
[What was said here since you last answered]
alice (msg 101): Thursday works for the deploy
bob (msg 102): Friday is safer, Thursday is the release freeze
you (msg 103): Daily build report: 3 builds, 1 failed ...

[The ask]
carol: @agent so which day did we pick?
```

- What was said comes from the platform's history where it can be read (Slack, Feishu/Lark), and from a buffer the
  channel keeps where it cannot (Telegram).
- Each place has a **cursor**: how far the last answered turn read. It moves forward when a turn's answer is recorded,
  so the next turn folds only what came after.
- The fold leaves out what the session already holds (the agent's own answers there), and keeps to a character budget,
  newest first. What the budget cuts is said in a line, never dropped silently.
- The fold is part of the ask's own prompt. It writes nothing else into the session.

## 5. Places, trunks and branches

A **place** is a room where people talk with the agent: a group chat, a channel, or a direct message. Each place has
one **trunk**: the session that holds the place's continuous memory. Every exchange in the place reaches the trunk,
either because it ran there or because the trunk folds it in later (§7).

A **branch** is any other session of a place, forked from the trunk or from another branch. There are two kinds, and
they differ only in why they exist:

- A **thread branch** carries a platform thread: a side conversation people opened under a message. It lives as long
  as people talk in the thread. This is what a channel already does for threads today.
- A **side branch** carries an ask that arrived while the session it would have gone to was answering someone else.
  It answers in the same place the ask was made, quoting it (Rule 2), so people never see it as a structure. It lives as
  long as people reply to it.

An **exchange** is one ask and everything that joins it while it runs (§8), answered by one reply.

What a place is, per platform:

| Platform | Place, with its trunk | Thread branches |
|---|---|---|
| Telegram | A private chat, a group, or a forum topic (each topic is a place of its own) | None: outside forum topics a reply chain stays in its place |
| Slack | A channel's top level, or a direct message | A thread, including the one Slack opens under the agent's answer to a top-level ask once someone writes in it, and each conversation of the Agent DM surface |
| Feishu/Lark | A chat, group or one-to-one; in a topic group, its topics' first posts | A topic (`thread_id`) |

Two things change on Slack. A top-level ask in a channel runs in the channel's trunk. Slack shows the answer in a thread
under the ask because it has no quote primitive, but that is where the answer is shown, not a separate place. In an
Agent DM, the first message of each conversation is a new ask in the DM, so it runs in the DM's trunk, and the
conversation's later messages are its thread branch. Both of participant-model §11's departures go away: a channel keeps
a memory of its room, and a DM keeps a memory of the person.

## 6. Where a message goes

Rule 1 decides first whether a message is addressed to the agent at all. A message that is not addressed is heard and
folded later; it never starts or joins a run. For an addressed message, the channel picks the session from what the
platform says about the message, never from the model's judgement of how long a task will take:

1. **A message in a thread** goes to that thread's branch. The branch is created at the thread's first answered message,
   forked where the thread's reply chain names, as threads fork today (`kit/thread-fork.ts`). The referent may be an
   exchange a side branch answered, so the fork's source is whichever session holds it.
2. **A reply to a message of an exchange** (its ask, or anything the agent posted for it) goes to the session that holds
   that exchange, whoever sends it. A reply is the most explicit "this continues that" a platform has.
3. **A message from someone whose own exchange is running in this place** (the room's top level, or the thread) goes to
   that running session.
4. **Anything else is a new exchange** and goes to the place's own session: the trunk in a room, the thread's branch in
   a thread.

Then the chosen session decides what happens:

- **Idle**: the message runs there.
- **Running, and the message came by the second or third route**: it is steered into the running exchange (§8).
- **Running someone else's exchange, and the message is a new exchange**: the channel forks a side branch from the end
  of the session's last finished exchange, and the message runs there. The fork point is the `answer.entryId` of the
  session's last completed message, so the branch never sees an ask that is still running. The side branch belongs to
  the same place and answers in it.

A direct message has one human in it, so its messages come by the third route while the agent works, and they steer.
A direct message never forks side branches. Its only branches are threads, where the platform has them.

A wake-up the agent set for itself returns to the session that set it, as it does today.

## 7. How the trunk learns what the branches said

There is no separate merge operation. The trunk learns what its branches answered through the fold, the way it already
learns discussion it was not part of. Only what the fold covers changes.

A place keeps an **exchange log**: for every answered exchange, the session that answered it, the ask (its message id,
sender and text), where it was asked (the room, or which thread), and the answer (its message ids and text). The
channel writes an entry when the answer is recorded, the same point at which a turn's cursor advances today. A trunk's
turn then folds two things since the trunk's last turn:

- **The place's discussion**, as today. It leaves out what the trunk's session already holds and what the exchange log
  covers, by message id.
- **The other sessions' exchanges** from the log: the side branches' and the threads'. They are rendered newest first in
  the same budget, an answer under the larger cap the fold already gives the agent's own posts. What the budget leaves
  out is said, and its thread is named, so the model can read the rest with the threads tool.

So when the trunk next runs, its ask reaches the model like this:

```text
[What was said here since you last answered]
Discussion:
  alice (msg 120): migration's done, I'll test it
Answered in other exchanges:
  bob asked (in this room): which day do we deploy?  You answered: Thursday; Friday is the release freeze.
  carol asked (in this room, replying to bob): what time?  You answered: 3 pm.
  erin asked (in thread "schema change"): can we drop the old column?  You answered: not before Monday's backfill.

[The ask]
dana: @agent sum up what we decided today
```

A branch's first turn folds what the session it forked from would fold if it ran now, read-only: that session's cursor
does not move. A side branch forks from the end of its source's last finished exchange, so its first turn starts as up
to date as its source would be. A thread branch forks where its thread branched, as today, and its first turn folds
the room as the thread's first turn does today. After that, a branch folds only its own place's discussion: the thread
for a thread branch, the room's top level for a side branch. Each session's fold leaves out only what that session
itself holds, so what another session posted in the same place reaches it as the agent's own post. Knowledge flows
toward the trunk. A thread stays a focused side conversation; it reads the room with the threads tool when a question
needs the room.

Because the fold is part of the ask's own prompt, no entries are written into the trunk and the roles of the
conversation keep alternating. Writing a branch's exchange into the trunk as entries was tried in the spike and
rejected (§15).

The exchange log is a cache, under the same contract as the participants store and the history cursor: it may shape a
prompt, never a durable claim. A lost log costs the trunk the other sessions' answers where the platform history does
not hold them (Slack thread replies, Telegram), never an ask.

## 8. Steering

A message steered into a running exchange is sent with `whenBusy: "steer"`. The agent takes it after the current tool
round, and the exchange's one answer covers it. If the exchange ended in between, the session is idle and takes the
message at once as an ordinary ask (an idle session ignores `whenBusy`, SPEC §5.3), so the race needs no handling of
its own.

The channel acknowledges a steered message the way it acknowledges an accepted ask, with its acceptance reaction, and
sends no reply of its own: the running exchange's preview goes on, and its answer appears where its ask was made.

## 9. A worked example

A group with Alice, Bob, Carol and Dana:

| When | What happens | Where it runs |
|---|---|---|
| 10:00 | Alice: "@agent migrate the database" (ten minutes of work) | The trunk is idle, so the trunk |
| 10:02 | Bob: "@agent which day do we deploy?" | The trunk is answering Alice. A side branch forks from the trunk's last finished exchange and answers Bob in the group, quoting him |
| 10:03 | Alice: "@agent keep the old column too" | Alice's exchange is running, so it is steered into it, and gets the acceptance reaction |
| 10:05 | Carol replies to Bob's answer: "@agent what time?" | A reply to Bob's exchange, so Bob's side branch, which is idle and has the deploy-day context |
| 10:10 | The migration finishes and Alice gets her answer | The trunk is idle again |
| 10:30 | Dana: "@agent sum up what we decided today" | A new exchange, so the trunk. Its fold carries Bob's and Carol's exchanges (§7) |

The place's sessions afterwards:

```text
group G
├─ trunk          Alice's migration (with her steer) → Dana's summary
├─ side branch    forked from the trunk: Bob's deploy day → Carol's time
└─ thread branch  a thread someone opened under the migration's answer
```

In a direct message the same person sends every message, so a message sent while the agent works is steered into the
running exchange. "Fix this bug" followed by "use pnpm, not npm" changes the running work instead of waiting behind it.

## 10. One cache identity per place

pi gives every fork a fresh provider session identity, which pi-ai sends as `prompt_cache_key` to OpenAI and Codex,
as the affinity header to Anthropic-compatible endpoints and OpenRouter, and uses to key Codex's cached WebSocket. A
branch with its own identity starts cold on providers that cache by that key.

FastAgent therefore gives every fork its parent's identity, through `Harness.open`'s `conversationCreated` option, in
`harnesses/pi-durable/agent.ts`. Every session of a place then shares the trunk's identity, transitively.
Extensions cannot do this: their only provider-request hook, `beforeProviderRequest`, replaces the request body, and
the identity is also used outside it, in headers and in the WebSocket key. This applies to every fork, including
`sessions.create({ forkFrom })` from any Caller; a fork shares its parent's prefix, so it helps them too.

Two things follow:

- Provider resources tied to an identity are released when the last session holding it ends, not when one does
  (#896).
- pi documents fresh identities for forks on purpose. The reason belongs in a note to pi, so that a change there does
  not silently undo this.

## 11. What people see

- An ask that arrives while the place's session answers someone else is answered at once, in place, by a side branch.
  The "⏳ Queued" notice appears only when the place has reached its limit of side branches (§12).
- A message that continues a running exchange gets the acceptance reaction and joins it.
- A long task in a group no longer holds anyone else's ask.
- Rule 2 is unchanged: every answer appears where its ask was made, and the agent opens no thread of its own.

## 12. Bounds

- **Side branches per place.** At most three side branches run at once alongside the place's own session. A new
  exchange beyond that queues behind the place's own session with today's notice. The number bounds what one place can
  run and spend at once. It is a constant, not a setting.
- **The fold** keeps its one character budget, now shared between discussion and other sessions' exchanges, newest
  first.
- **The exchange log and the message-to-session map** are bounded per place and evict the least recently used places
  first, as `history.json` does.

## 13. State and restarts

A channel's own state grows by three things, all under its state directory:

- the place's trunk, and its sessions: the thread map it has today, plus side branches;
- which session holds each recent message, asks and the agent's posts, for the second route of §6;
- the exchange log, and a cursor per session instead of per place.

A session is created in the order every Caller follows ([architecture.md](architecture.md) §2): the session, then its
record, then the message. A restart resumes every session's running work, which pi does for any conversation. The
per-place turn queue becomes a queue per session.

## 14. Evidence

A spike on pi-durable 1.5.0, recorded in #989, checked the chain this design rests on:

| Check | Result |
|---|---|
| A branch forked from the trunk's last finished exchange runs while the trunk's run is held | It answers, and sees the trunk's finished history but not the running ask |
| A steer from the same sender joins the running trunk | Yes |
| Two branches finish out of order; a branch of a branch | Both work. A write into a middle branch does not reach the trunk on its own, which is why every session's exchanges reach the trunk directly through the log |
| Compaction after many exchanges, and during a run | Works |
| A restart with a running trunk, a running branch and a pending write | Both runs answer; a tool cut off by the close gets an interrupted result |
| A user/assistant pair written into the running trunk | **Ends the trunk's run** with `nothing_to_answer`, so its asker never gets an answer. One reason the trunk learns through the fold |
| FastAgent's own system prompt and tools across a place's sessions | Byte-identical, so a shared prefix holds |
| Cache with a shared identity, `openai-codex/gpt-5.6-luna`, branches running alongside the trunk, 4 rounds | Branch first requests: 4/4 hits and 97% of input read from cache, against 1/4 and 24% with fresh identities. The trunk is unaffected |
| The same on `deepseek/deepseek-flash` | Hits either way: DeepSeek caches by content |

## 15. Alternatives rejected

| Alternative | Why not |
|---|---|
| One serialized session per place (today) | A place waits behind one exchange, and a correction waits behind the work it corrects |
| A router agent and worker agents ([DeepSeek's Super-agent](https://github.com/deepseek-ai/dsh-superagent-prototype)) | It imposes a second role on the author's definition, which FastAgent serves as written. The same split comes from routing by platform signals, with one definition |
| Letting the model decide when to hand work off | DeepSeek measured a single session with a subagent tool: under a neutral prompt it never delegated, and its p95 completion time was 29.5 minutes. A structural rule does not depend on that judgement |
| Every ask in a branch of its own | The trunk would never run, so every fork would start from a stale base. This is today's Slack Agent DM, generalized |
| Writing a branch's exchange into the trunk as entries | It needs a write in the Agent API, and its shape has to depend on whether the trunk is running: a user/assistant pair written mid-run ends the trunk's run (measured), and a single user message is the only safe mid-run shape. The fold gives the trunk the same knowledge with no new operation |
| Branches folding the trunk's later exchanges | A thread is a focused side conversation; the room's later activity would be noise in it. It reads the room on demand |
| A session per person in a room | Still rejected (participant-model §9): the room's conversation belongs to the room |
| Fresh provider identities for forks | Measured above: branches start cold on providers that cache by that key |

## 16. Accepted costs and open questions

- **An unrelated ask from the same person joins their running exchange.** In a group they can open a thread to keep it
  apart. Treating every message as a new exchange instead would make a correction a second task.
- **A side branch is a snapshot from its birth.** Two exchanges running side by side do not see each other; the trunk's
  next turn sees both.
- **The trunk learns a branch's answer as text in its fold**, not as its own assistant message, and does not see the
  branch's tool results. Where it needs them, it reads the thread.
- **Consecutive user-side messages.** A steer placed after a tool round, and a compaction summary followed by a kept user
  message, give the model two user-side messages in a row. That is pi as it is today, not something this design adds.
  Whether Bedrock accepts it is not verified.
- **One cache key per place has a rate.** OpenAI says requests for one `prompt_cache_key` and prefix above about 15 a
  minute overflow to other machines, and so miss the cache. A busy place with branches can reach that; it would cost
  cache, not correctness.
- **Every session is listed.** Side branches are sessions, so `sessions.list` shows them.
- **Not measured yet**: how much of the fold budget other sessions' exchanges take in a busy group, and the cache
  behavior on Anthropic (expected to match DeepSeek, since it caches by content).

## 17. What changes elsewhere

| Where | Change |
|---|---|
| [participant-model.md](participant-model.md) | Rule 3 and §6 replaced by this document. §7: a thread's conclusion reaches the room through the trunk's fold. §11: Slack's two departures go away |
| [place-history.md](place-history.md) | The exchange log as a second source of the fold; a cursor and an output record per session instead of per place |
| `channels/kit/` | Routing by the four routes of §6; side branches; a turn queue per session; steering (`whenBusy: "steer"`); the exchange log; `thread-fork.ts` forking from whichever session holds the referent |
| `conversation-sessions.ts` | A place's trunk, its branches, and the message-to-session map |
| `harnesses/pi-durable/agent.ts` | `conversationCreated` giving a fork its parent's provider identity; releasing provider resources per identity (#896) |
| Agent API | Nothing |

## Out of scope

- Who may talk to a channel's agent. It is designed separately.
- Continuity of a personal agent across places and hosts (one person in Telegram, Slack and Kage). It comes later, as
  a choice of where trunks fold into, on top of this design.
- Proactive work the agent starts without being asked.
- Chat commands such as `/stop`, which keep their current behavior.
