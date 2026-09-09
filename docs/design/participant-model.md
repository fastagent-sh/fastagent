---
title: Participant model
description: "How a FastAgent bot behaves inside a collaboration tool (Feishu/Lark, Slack): the participant axiom, the three rules derived from it, and the session/placement/summon mapping that follows."
type: design-doc
status: current
updated: 2026-07-25
---

# Participant model

The interaction model for chat channels in collaboration tools — who the bot answers, where the answer
appears, and what it remembers. It is the *why* behind the routing and session code in
`src/channels/feishu/`, `src/channels/slack/`, and `src/channels/telegram/`; the mechanisms are
documented in [core.md](core.md).

The model is derived, not assembled. Everything below follows from one axiom, so changing the axiom
invalidates the rules rather than adjusting them.

## 1. The axiom

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

> A participant hears everything said in the room, and speaks only when addressed.

The two capabilities are independent, and FastAgent implements them separately: everything heard but
not addressed to the agent is buffered as context (`channels/kit/context-buffer.ts`) and folded into
the next answered turn in that place; speaking is governed by rule 1.

This is what the platform's sensitive group-message scope actually buys. It does not grant the right
to speak — it grants the ability to *hear*. The permission selects a posture rather than a feature:

| Posture | Permission | Experience |
|---|---|---|
| Present participant | group-message scope granted | hears context, answers with it |
| Summoned tool | mention-only | sees only what is addressed to it |

## 3. Rule 1 — when to speak

People address each other by name in a crowd and drop the name when a conversation has only two
sides. The rule is therefore about the *conversation*, not the chat type:

> **Speak without being addressed if, and only if, the agent takes part in this place and has not
> heard a second human in it. Otherwise require an explicit mention.**

Direct messages are not a special case — they are the instance of the rule where only one human can
be heard.

| Place | Humans heard | Behavior |
|---|---|---|
| Direct message | 1 | always answer |
| Group main timeline | many | require @mention |
| Thread where only one human has spoken | ≤1 | answer bare messages |
| Thread where a second human has spoken | ≥2 | require @mention, keep listening |

The last row is what "answer everything in a thread the agent once joined" gets wrong: a colleague who
keeps answering every sentence of a three-way discussion because they were asked one question is
behaving badly.

### The rule is about what the agent HEARD, not about who is really there

A deliberate weakening. No platform transmits "who is taking part", and none emits an event when
someone stops; a claim about true membership can only come from reading the thread back on the
acceptance path — a remote, paginated, deadline-bound call inside the event ACK window. That was built
and removed: it bought a claim its own page cap made incomplete anyway, at the price of a per-platform
failure taxonomy, an ACK budget, request aborts, a completeness flag, and a duplicate-delivery join.
Observation makes the weaker claim the rule actually needs, and it is free.

The cost, stated plainly: **a thread the agent joined before this deployment — or before a lost state
file — reads as unheard, so it takes one mention to re-enter.** That is the bootstrap every thread
starts with, it self-heals in one message, and it is visible to the user.

**The invariant is that every human the channel hears in a thread is recorded there, until a second one
is known** — not that a record always holds one, and not that `humans` is ever a complete roster. The
rule asks nothing beyond "is there a second?", so the store stops counting at two; what it must never
do is miss the first two. Missing one is the under-count that makes the agent speak into a crowd.

Both halves of a record are written under the SAME gate — a group thread, a human sender — so
"answered here but heard nobody" cannot arise. That gate is built from STRUCTURAL facts only (is this
a group? is this a thread?) and never from configuration: configuration changes while records outlive
the change, so gating on it leaves `agentSpoke` on disk with the humans of the intervening window
missing. Unread records are harmless: they cost two ids, and the cap evicts bystander threads before
threads the agent takes part in.

Two accepted costs:

- A record is only as complete as the channel's hearing when it was written. An agent answering a
  mention in a restricted posture records itself plus the human who summoned it; widen the posture
  later and the thread reads "participant + one human" though it holds several. The failure is one
  unwanted reply, it corrects itself the moment a second human speaks, and detecting it needs exactly
  the completeness bookkeeping this design removed. Deleting the state file forces every thread back
  to the mention bootstrap.
- A human whose event carries no usable id (Feishu's `sender_id` is a union, and which members a
  tenant populates is app configuration) is counted under a synthetic per-message id, so two such
  messages fill the thread's human slots. Collapsing them into one speaker would be wrong in the
  dangerous direction — on a tenant carrying no ids at all, every human would read as the same one.
  The channel warns once per process, the first time it hears an unattributable sender in a group
  thread.

Observations accumulate and are never shed: the absence of a signal is not evidence that someone left,
and the error directions are not symmetric.

**Participation** is required so the agent does not barge into a human thread it was never part of.
The agent is a participant of a thread once it has answered in it, so bootstrapping is the ordinary
social move: mention it once inside the thread. (A thread's root message lives in the main timeline,
so the root does not establish participation.)

**Mentioning only other people is not addressing the agent.** Such a message is discussion; it is
buffered, never answered.

## 4. Rule 2 — where to speak

> **Answer in the place the question was asked. Never relocate an answer silently.**

| Asked in | Answered in |
|---|---|
| Main timeline | main timeline, quoting the question |
| Thread | that thread |
| Direct message | the direct message |

The agent does not open threads on its own. Automatic placement requires a heuristic ("is this a long
task?"), and an unpredictable answer location is worse than an untidy timeline.

*Non-goal, deliberately deferred:* relocating a long-running task into a thread to release the main
timeline's turn lock. It is defensible only if announced in place, and only with a reliable "this will
take a while" signal.

## 5. Rule 3 — what to remember

> **Memory follows the place. A room has one memory. A thread starts from what the room knew and
> keeps its own history. What happens in a thread flows back to the room.**

| Place | Session | Rationale |
|---|---|---|
| Direct message | one continuous session per chat | a colleague does not restart every message |
| Group main timeline | one session per chat, shared by everyone | B following up on A's question is the normal case, and the agent must remember its own answers |
| Thread | one session per thread, anchored to what it branched from | a side conversation is separate, not amnesiac |

The rows name *places*, so a platform whose primitives make a different thing the place lands
differently while obeying the same rule — see §11.

Sessions are **per place, never per person**. Scoping memory per user would break the most common
collaborative pattern (one person following up on another's exchange) and would hide the agent's own
answers from everyone but the asker.

## 6. Concurrency follows the same rule

The unit of concurrency is the session, and the session is the place:

- one conversation is sequential: people take turns, and an answer may depend on the previous one;
- separate conversations are parallel: threads proceed independently.

Two turns in one place serialize (`channels/kit/turn-queue.ts` FIFO, and the engine's single-writer
lease in `engines/pi/turn-kit.ts`). Two turns in different places run concurrently.

Finer-grained concurrency (parallel turns *inside* one session) is rejected: a conversation needs
convergence, and a tree only provides divergence. Concatenating two independently computed turns
afterwards is a stale read — harmless when the two asks are causally independent, silently wrong when
the second refers to the first, and there is no way to tell them apart without understanding the
content. The user already tells us which asks are independent: by opening a thread.

## 7. What a thread does not tell the room

*Non-goal, deliberately deferred:* folding a thread's conclusion back into the room. Two different
things are lost when a side conversation ends — the room's session does not hold what was decided
(cheap to fix, invisible to everyone) and the people in the room do not know it (needs a message, so
it needs consent). If the gap is felt, the memory half is the one to build first, and the shape is the
context buffer's: record the thread's latest exchange per thread, fold it into the room's next turn,
commit on `completed`.

## 8. Thread context: the inheritance ladder

A thread must start from something. Four rungs, increasing in cost:

| Rung | Mechanism | Gives the thread | Status |
|---|---|---|---|
| 1 | referent anchor, truncated | the followed-up message, cut at some display-sized bound | rejected |
| **2** | **referent anchor, bounded by the platform** | **the followed-up message in full (`REFERENT_MAX_CODE_POINTS`)** | implemented |
| **3** | **room-buffer fold, in the prompt** | **what the room heard but no session absorbed — text and attachments** | implemented |
| **4** | **session inheritance (fork at the branch point)** | **the room's history up to where the thread branched — text, images, tool results — windowed** | implemented |

Rung 1 fails the model's own main path: following up on the agent's answer, where the answer is
routinely longer than the cut.

**Rung 2** uses one bound for every channel, derived rather than chosen: a referent is the exact text
the asker points at, so the cut must clear the largest message a chat platform accepts (4096,
Telegram's cap and the tightest of ours). This is a fidelity bound and must not be confused with the
context buffer's per-line bound, which is a fairness quota inside a shared budget. A quoted message is
always loaded — the quote is the user pointing at something that may predate this session. (Skipping
it inside a thread the agent had already answered in was tried: deciding whether the session really
held it needs a second fact — whether the channel RECEIVED the messages in between — which depends on
a permission that changes over time while the record is durable.) An unreadable referent degrades to a
marker in the prompt: context is not the ask, and losing it must not cost the answer.

On Feishu/Lark — and only there, because that platform threads every reply to a parent while
Telegram's update embeds exactly one `reply_to_message` object and Slack carries none — the anchor
also resolves the referent's reply CHAIN: the ancestors above the quoted message, walked to the
platform-defined root and rendered oldest-first as context. Ancestors are context, not the ask, and
every bound follows from that: their text shares ONE further `REFERENT_MAX_CODE_POINTS` budget across
the whole chain, their attachments share the buffered tier's `BUFFER_ATTACH_MAX` budget with the
context buffer (chain refs take slots first), and an unloadable one costs a note, never the turn. Any
walk that ends short of the root — the 8-ancestor IO cap, an exhausted budget, an unreadable ancestor,
a cycle in corrupt data — leaves the same visible truncation line, because a chain rendered without it
would read as complete and the model would take the oldest fetched node for the original ask. One cost
is deliberate: the walk repeats per reply turn, so an established session re-reads chain text it may
already hold (attachments are deduplicated by message identity; text cannot be, from a layer that
cannot read the session).

**Rungs 3 and 4 are one mechanism with two parameters, implemented as session inheritance.** The
channel states two facts only it knows — which place this one branched from (`scope.parentSession`,
SPEC §8's extension mechanism) and which message ids may locate the branch point (`scope.branchHints`:
the referent and its reply chain) — and the engine does the rest ONCE, when the thread's session is
first created: the session existing is the record that the decision was taken, so there is no marker
to persist and no decision to retry. The fork copies the room's active path up to the branch point (a
hit is extended to the end of its exchange, so a mid-exchange fork does not inherit a question without
its answer; a miss falls back to the room's present, with a warn). What the model sees is bounded by
one mechanical compaction mark — the newest 50 exchanges within a ~50K-token estimate, images priced
flat — generated from real session entries instead of re-serialized prompt text, so images and tool
results come along for free. The newest exchange is a floor, kept whole even when it alone exceeds the
budget. Every edge (missing parent, oversize journal, torn tail line, a dangling tool call from
forking a mid-turn room) fails toward an empty session with a warn.

**The two rungs carry different halves.** The fork carries what the room's SESSION knew; a room's
session only advances when the agent is summoned, so discussion since its last answered turn sits in
the context buffer, absorbed by nothing. The thread's FIRST turn folds that bucket into its prompt,
read-only — the room's own next answered turn still commits it, so each place sees the discussion
exactly once in its own memory, and the fold's attachments cross as real attachments on the buffered
tier rather than as marker lines.

**Once, not per turn**, and this is not an optimisation: a prompt lands in the session, so the thread's
second turn already has the first turn's fold in its context. Re-folding puts a second identical copy
of the block, and of its images, in ONE context window (measured: three turns, three copies of each).
After the first turn the content is already present, so only chatter arriving LATER could carry
anything new — and that does not reach the thread at all.

The first-turn fact comes from the participants store, which is a cache by contract (bounded,
evictable, deletable). That is acceptable HERE precisely because the fold is prompt-bound: an evicted
record costs one extra fold of a block whose label is true whenever it is written. The converse is the
rule worth keeping: **this cache may not gate a claim that outlives the turn.** Write the same content
into the newborn session as a birth mark and a forgotten record permanently attributes the room's
CURRENT chatter to a thread that branched long before. Repetition degrades an answer; a stale durable
label misstates the past.

*Rejected: making the room absorb eagerly* — writing each un-summoned message into the room's session
at ingress. It would delete rung 3 entirely, and it fails on three measured counts: durable session
writes take the run lease ([session-control.md](session-control.md) §9), so ingress would block behind
a multi-minute turn; that blocking sits on the PRE-ACK path, where the webhook must answer before the
platform re-pushes; and consecutive ambient user entries reach the provider unmerged — Bedrock rejects
them (`roles must alternate`), and `deploy agentcore` is a shipped host.

Adoption is per channel, because only a channel knows its places' lineage: Feishu/Lark set the scope
fields and fold the room bucket; Telegram and Slack do not yet.

*Known asymmetry, accepted:* room → thread transfers once, when the thread starts, and nothing flows
back (§7).

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
| A `threaded` / `continuous` session-mode pair | couples session identity, placement and the summon rule into one switch; an endpoint-shaped bot uses an explicit `route` (§1) |

## 10. Mapping to platforms

| Capability | Feishu / Lark | Slack |
|---|---|---|
| Side conversation | topic (`thread_id`) | thread (`thread_ts`) |
| Hearing the room | sensitive group-message scope | channel message events |
| Sharing a thread's outcome | ask the agent to post to the room | native "also send to channel" |
| Dedicated direct surface | ordinary p2p chat | assistant pane |

## 11. Per-platform reach

The rules converge; the mappings do not, because the primitives differ.

| | Feishu/Lark | Slack | Telegram |
|---|---|---|---|
| Place | chat, `chat:thread_id` | channel, `channel:thread_ts` | chat, `chat:message_thread_id` |
| Answer in a group | quoted reply in the room | **thread reply** — Slack has no quote primitive, so a thread under the message *is* answering in place | quoted reply in the room |
| Direct messages | one continuous chat | **assistant threads** — each conversation gets a thread with a title and status | one continuous chat |
| Thread rule (§3) | what the channel heard in the thread | what the channel heard in the thread | not applicable — see below |
| Session for a group ask | the room (`<kind>:<chat_id>`) | the **thread the answer creates** (`slack:<team>:<channel>:<thread_ts>`) | the room (`chat_id`) |
| Stateless addressing | — | — | **reply-to-bot**: the update embeds the parent's sender |

The session row is the same rule with a different place. Feishu and Telegram answer a group ask *in
the room*, so the room is the place. Slack has no quote primitive, so answering in place means opening
a thread on the ask — which makes that thread the place. Neither channel offers a session mode: the
place follows from the platform's own way of attaching an answer.

Slack pays for that twice, and both are departures from §5:

- **In a channel**, the room-level memory §5 argues for is lost — a second person asking at channel
  top level starts a fresh place. That is consistent with Slack, where a follow-up belongs in the
  thread; buying it back would mean either serialising an entire channel behind one session or
  splitting threads into two kinds.
- **In a direct message**, each top-level message opens its own assistant thread and therefore its own
  session — the shape §9 rejects everywhere else. It stands here because Slack's Agents surface *is* a
  list of conversations: each thread carries its own title and status, and the platform's model of a
  DM assistant is one thread per topic. A follow-up continues inside the thread.

Two consequences worth stating:

- **Telegram needs no participation store at all**, and it is the channel that shaped this design. Its
  Bot API exposes no history read, so it was never able to claim more than it had heard — and it
  carries the parent message *inside* the update, so "is this a reply to me?" is answered statelessly
  and survives restarts with no state. The other two ended up in the same epistemic position (§3) with
  a state file, because they have no equivalent primitive.
- **Feishu/Lark cannot borrow it.** Its event carries `parent_id` as a bare id with no sender, so
  recognising a quote-reply to the agent would need a platform read per message or a durable record of
  every message the agent has sent. Neither is worth it while the thread rule covers the same flow.
