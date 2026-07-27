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

> **Speak without being addressed if, and only if, the agent takes part in this place and has not
> heard a second human in it. Otherwise require an explicit mention.**

Direct messages are not a special case — they are the instance of the rule where only one human can
be heard. The derived behavior:

| Place | Humans heard | Behavior |
|---|---|---|
| Direct message | 1 | always answer |
| Group main timeline | many | require @mention |
| Thread where only one human has spoken | ≤1 | answer bare messages |
| Thread where a second human has spoken | ≥2 | require @mention, keep listening |

The last row is the part that "answer everything in a thread the agent once joined" gets wrong: a
colleague who keeps answering every sentence of a three-way discussion because they were asked one
question is behaving badly. The agent must fall back to listening when the conversation stops being
a two-party exchange.

### The rule is about what the agent HEARD, not about who is really there

This is the load-bearing decision, and it is a deliberate weakening. No platform transmits "who is
taking part", and none emits an event when someone stops; a claim about true membership can only come
from reading the thread back on the acceptance path — a remote, paginated, deadline-bound call inside
the event ACK window.

That was built, and then removed. It bought a claim its own page cap made incomplete anyway, and it
dragged in a failure taxonomy per platform, an ACK budget, request aborts, a completeness flag with a
refusal-flag sibling, and a duplicate-delivery join — which is where nearly every defect lived.
Observation makes the weaker claim the rule actually needs, and it is free: the channel already sees
these messages, and it hears everything in a place it can see (§2).

What the weaker claim costs, stated plainly: **a thread the agent joined before this deployment — or
before a lost state file — reads as unheard, so it takes one mention to re-enter.** That is the same
bootstrap every thread starts with, it self-heals in one message, and it is visible to the user. It is
not the failure this replaced, which was silently mention-only, forever, with no signal.

**The invariant is that every human the channel hears in a thread is recorded there, until a second one
is known** — not that a record always holds one, and not that `humans` is ever a complete roster. The
rule asks nothing beyond "is there a second?", so the store stops counting at two; what it must never
do is miss the first two. Missing one of them is the under-count that makes the agent speak into a
crowd.

Both halves of a record are therefore written under the SAME gate — a group thread, a human sender —
so "answered here but heard nobody" cannot arise at all. The predicate still admits it (`humans` of
zero or one), which states the intent: ambiguity comes from a second person *talking*, not from the
absence of a first. But it is not a state the channels can produce. A custom route may admit a bot the
built-in routes filter out; answering one is not participation the rule should act on, so such a thread
keeps no record and the first human to speak there still needs the mention bootstrap. (The agent half is additionally
narrowed — it must be the same place and the place's own session — which only ever leaves a bystander
record, never a participant one with humans missing.)

That condition is built from STRUCTURAL facts only — is this a group? is this a thread? — and never
from configuration. A group-behaviour setting or the presence of a custom route is the tempting gate,
since nothing reads participation without them, but configuration changes while records outlive the
change: gate on it, switch back, and `agentSpoke` is still on disk with the humans of the intervening
window missing. Both channels therefore record in postures where no rule will read the result. The
condition is the same in both: a group thread, whatever the posture. Unread records are harmless:
they cost two ids, and the cap evicts bystander threads
(ones the agent has only listened to) before threads it takes part in, so listening traffic can never
push out a thread being served.

The cost runs both ways, and the second direction is not free. A record is only as complete as the
channel's hearing when it was written: an agent answering a mention in a restricted posture (Slack
`mentions`, Feishu without `im:message.group_msg`) records itself plus the human who summoned it, while
everyone else's bare messages in that thread are never delivered. Widen the posture later and the thread
reads "participant + one human" though it holds several. That is accepted rather than defended against —
the failure is one unwanted reply, it corrects itself the moment a second human speaks, and detecting it
needs exactly the completeness bookkeeping this design removed. An operator changing posture on a live
deployment can delete the state file to force every thread back to the mention bootstrap.

One cost in this model is NOT self-healing, and it is worth stating separately: a human whose event
carries no usable id (Feishu's `sender_id` is a union, and which members a tenant populates is app
configuration) is counted under a synthetic per-message id, so two such messages fill the thread's
human slots and it requires an @mention from then on. Collapsing them into one speaker would be tidier
but wrong in the dangerous direction — on a tenant that carries no ids at all, every human would read
as the same one. Deleting the state file is the only reset; the channel warns once per process, the
first time it hears an unattributable sender in a group thread — the only place participation is
recorded, so a deployment used purely in direct messages never trips it (and never needs to).

Two consequences worth naming rather than discovering:

- A thread where several people are present but only one has spoken *while the agent was listening*
  reads as two-party. Given the rule's intent — ambiguity comes from several people **talking** — that
  is arguably more faithful than counting silent members.
- Observations accumulate and are never shed. The absence of a signal is not evidence that someone
  left, and the error directions are not symmetric: over-counting humans makes the agent ask to be
  named, under-counting makes it speak into a crowd.

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

The rows name *places*, so a platform whose primitives make a different thing the place lands
differently while obeying the same rule — see §11.

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

## 7. What a thread does not tell the room

*Non-goal, deliberately deferred:* folding a thread's conclusion back into the room. Two different
things are lost when a side conversation ends — the room's session does not hold what was decided
(cheap to fix, invisible to everyone) and the people in the room do not know it (needs a message, so
it needs consent). Nothing is built for either until the gap is felt in use: a person who wants the
room to know can already ask the agent to post there, and the agent's own memory gap has not yet
produced a complaint. If it does, the memory half is the one to build first, and the shape is the
context buffer's: record the thread's latest exchange per thread, fold it into the room's next turn,
commit on `completed`.

## 8. Thread context: the inheritance ladder

A thread must start from something. Four rungs, increasing in cost:

| Rung | Mechanism | Gives the thread |
|---|---|---|
| 1 | referent anchor, truncated | the followed-up message, cut at some display-sized bound |
| **2** | **referent anchor, bounded by the platform** | **the followed-up message in full (`REFERENT_MAX_CODE_POINTS`)** |
| 3 | seed injection | the room's last N exchanges, in the thread's first prompt |
| 4 | session fork | the room's entire history, reasoning and tool results included |

Rung 1 fails the model's own main path: following up on the agent's answer, where the answer is
routinely longer than the cut. **Rung 2 is implemented**, with one bound for every channel, derived
rather than chosen: a referent is the exact text the asker points at, so the cut must clear the
largest message a chat platform accepts (4096, Telegram's cap and the tightest of ours). Anything
smaller loses a legal message's tail silently. This is a fidelity bound and must not be confused with
the context buffer's per-line bound, which is a fairness quota inside a shared budget. A quoted message is always loaded — the quote is the
user pointing at something that may predate this session. (Skipping it inside a thread the agent had
already answered in was tried: deciding whether the session really held it needs a second fact, whether
the channel RECEIVED the messages in between, which depends on a permission that changes over time
while the record is durable. Every way of gating it failed toward a silently missing quote, for the
price of one extra read.) An unreadable referent degrades to a marker in
the prompt: context is not the ask, and losing it must not cost the answer. Rung 3 is the next
increment if anchors prove too narrow.

Rung 4 (`SessionRepo.fork`, which would need an optional lineage field on `Scope`) is **not planned**:
it over-delivers by copying the whole room — including everyone's unrelated conversations — into a
focused side discussion, and it pays that cost on every turn rather than once. Its only exclusive
capability is preserving the agent's reasoning and tool results; that is worth revisiting when a real
case appears, not before.

*Known asymmetry, accepted:* room → thread transfers once, when the thread starts, and nothing flows
back (§7). A thread neither learns about later room activity nor reports its own.

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
| Side conversation | topic (`thread_id`) | thread (`thread_ts`) |
| Hearing the room | sensitive group-message scope | channel message events |
| Sharing a thread's outcome | ask the agent to post to the room | native "also send to channel" |
| Dedicated direct surface | ordinary p2p chat | assistant pane |

## 11. Per-platform reach

The rules converge; the mappings do not, because the primitives differ. Convergence means each channel
implements the same three rules with its own platform's notion of a place — not that they answer in
the same shape.

| | Feishu/Lark | Slack | Telegram |
|---|---|---|---|
| Place | chat, `chat:thread_id` | channel, `channel:thread_ts` | chat, `chat:message_thread_id` |
| Answer in a group | quoted reply in the room | **thread reply** — Slack has no quote primitive, so a thread under the message *is* answering in place | quoted reply in the room |
| Direct messages | one continuous chat | **assistant threads** — Slack's Agents surface gives each conversation a thread with a title and status | one continuous chat |
| Thread rule (§3) | what the channel heard in the thread | what the channel heard in the thread | not applicable — see below |
| Session for a group ask | the room (`<kind>:<chat_id>`) | the **thread the answer creates** (`slack:<team>:<channel>:<thread_ts>`) | the room (`chat_id`) |
| Stateless addressing | — | — | **reply-to-bot**: the update embeds the parent's sender |

The session row is the same rule with a different place, not a different rule. Feishu and Telegram
answer a group ask *in the room*, so the room is the place and keeps one memory. Slack has no quote
primitive, so answering in place means opening a thread on the ask — which makes that thread the
place, and its memory starts there.

Neither channel offers a session mode: the place follows from the platform's own way of attaching an
answer, so there is nothing left to select.

Slack pays for that twice, and both are departures from §5 worth naming rather than glossing:

- **In a channel**, the room-level memory §5 argues for is lost — a second person asking at channel
  top level starts a fresh place. That is consistent with Slack, where a follow-up belongs in the
  thread; buying it back would mean either serialising an entire channel behind one session or
  splitting threads into two kinds, both of which cost more than the case is worth.
- **In a direct message**, each top-level message opens its own assistant thread and therefore its own
  session — the shape §9 rejects as "a new session per ask" everywhere else. It stands here because
  Slack's Agents surface *is* a list of conversations: each thread carries its own title and status,
  and the platform's own model of a DM assistant is one thread per topic, not one linear chat. A
  follow-up continues inside the thread, where the session already holds the exchange.

Two consequences worth stating rather than papering over:

- **Telegram needs no participation store at all**, and it is the channel that shaped this design. Its
  Bot API exposes no history read, so it was never able to claim more than it had heard — and it
  carries the parent message *inside* the update, so "is this a reply to me?" is answered statelessly
  and survives restarts with no state whatsoever. The other two ended up in the same epistemic
  position (§3) with a state file, because they have no equivalent primitive; the weakest-claim channel
  turned out to be the simplest and the least buggy, which is the argument that removed the read.
- **Feishu/Lark cannot borrow it.** Its event carries `parent_id` as a bare id with no sender, so
  recognising a quote-reply to the agent would need a platform read per message or a durable record of
  every message the agent has sent. Neither is worth it while the thread rule covers the same flow: a
  quote-reply to the agent in a group's main timeline is buffered rather than answered, and the user
  either mentions it or opens a thread.

## 12. Migration

The participant model replaces the earlier `threaded` / `continuous` mode pair. Those two options
coupled three independent axes — session identity, reply placement, and the summon rule — so a user
who wanted room-level sessions was forced to also give up mention-free thread continuations. The
model above sets each axis on its own principle, which leaves nothing for the modes to select.

For Feishu/Lark, state left by the previous model is cleaned up on the next start: `owned-threads.json`
is removed, and `buffers.json` buckets keyed `<chat>:root:<id>` are dropped at load — the re-keying
means no place key can produce that shape again, so nothing could ever fold or clear them.

That discards real content, once: the retired shape covered EVERY thread bucket and every main-chat
quoted-reply bucket, so buffered discussion in threads does not survive the upgrade (a chat's own
`<chat>` bucket does). A turn that was in flight across the upgrade loses its buffered context too —
its `bufferKey` was persisted under the old shape. Both are one-time, and the dropped count is logged.

Breaking changes for existing Feishu/Lark deployments:

- direct messages become one continuous conversation instead of one session per top-level message;
- group summons answer in place instead of opening a thread;
- threads answer bare messages only while no second human has been heard in them;
- **the concurrency unit changes with the session.** Turns serialize per session (§6), so a whole room
  — and a whole DM chat — is now one queue. Previously each top-level summon was its own session and
  ran concurrently; now a second person's `@Agent` in a busy room waits behind an unrelated
  multi-minute turn. Opening a thread is the way to run something alongside it;
- **sessions are re-keyed** from `<kind>:<root_id ?? message_id>` to the place
  (`<kind>:<chat_id>`, or `<kind>:<chat_id>:<thread_id>` in a thread — §5; the kind brand stays). Existing session history is NOT migrated: every conversation starts fresh
  after the upgrade, which reads to users as the agent forgetting, and the old records stay in the
  session store unreferenced (there is no TTL or GC — see docs/feishu.md). Deleting them is optional
  and safe; nothing will ever read them again.

For Slack, placement and sessions are unchanged **under the default configuration**; what changes is
the summon rule: a thread the agent has answered in admits bare replies until a second human is heard
there, which restores the mention requirement. `owned-threads.json` is removed on the next start.

Breaking changes for existing Slack deployments:

- `directMessageSession` and `groupMessageSession` are removed. Passing either now fails at startup
  rather than being ignored — placement and session identity follow from Slack's own primitives (§5),
  which leaves nothing for the options to select;
- a deployment that set either to `continuous` therefore changes both where answers land and how
  sessions are keyed. Existing history is not migrated, for the same reason as Feishu's re-keying above.
