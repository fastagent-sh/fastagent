---
title: Channel sessions and shared context
description: "A session key follows the platform's structure (a DM, a sender in a group's main timeline, a thread), input is steered into the session that owns it, and sessions read each other's discussion through the place's history: routing, concurrency, context, answer delivery and recovery across Telegram, Slack and Feishu/Lark."
type: design-doc
status: proposed
updated: 2026-11-10
---

# Channel sessions and shared context

**Status: proposed ([#989](https://github.com/fastagent-sh/fastagent/issues/989)), implemented in part.** Every channel
send is steered and a shared answer is delivered once ("Input reaches a running session by steering", "Answers,
delivery and restart"), and a turn's read starts after the ask its session was last sent ("Where a turn's read starts",
by `kit/ask-log.ts`; the table there holds asks, and the agent's own posts are still excluded per place). Session keys by
sender (Telegram and Feishu groups' main timelines; the agent's own answers are excluded per conversation) and replies
steered into the session they name (`kit/message-owners.ts`, Telegram and Feishu main timelines) are built, and so are
Feishu thread forks from the session holding the message a topic was opened on, with a topic that names none starting
empty. This document proposes replacing [participant-model.md](participant-model.md)
Rule 3 and §6, and revising its thread-context and platform mappings. The participant axiom and the distinction between
hearing and answering remain.

The hard problem is letting one agent work for several people in one place at once, use what the others said, and take
a correction without mistaking somebody else's request for part of the current task.

> **A session key follows the platform's structure. Input goes to the session that owns it. Sessions learn about each
> other from the place's discussion, not from a shared session.**

All sessions use the same agent definition. There is no router agent, no worker role, no trunk that absorbs the other
sessions, and no model classifying whether a message continues a task.

## What people should experience

- One person's long task does not hold up another person's question in the same group.
- A correction sent while the agent works reaches that work at its next step.
- A thread keeps one conversation, whoever speaks in it.
- A question can use what others said in the place, including a human decision made after the agent's answer.
- Every accepted request has an observable outcome, including failures, and survives a restart.
- Answers stay attached to their questions.

Hearing is not answering. The existing summon policy still decides whether a message reaches the agent.

## Session keys

The key is a function of what the platform tells us about a message. It never depends on what the message means.

| Where the message is | Session | Runs together with |
|---|---|---|
| A direct message (Telegram, Feishu/Lark) | One per DM | Nothing else in that DM |
| A Slack DM thread | One per thread | Other threads |
| A group's main timeline (Telegram group, Feishu/Lark ordinary group) | One per place and sender | Other senders' sessions |
| A thread or topic (Slack thread, Feishu/Lark topic, Telegram forum topic) | One per thread, shared by everyone in it | Other threads and senders |

Slack has no main timeline to key: every top-level ask in a channel opens its own thread, which is its own session, as
it does today. A Telegram forum topic is a thread: one session for everyone in it.

This follows the common design of group agents. Hermes Agent keys sessions by platform, chat, thread and, in groups,
participant, with threads shared by default.

A session is a pi-durable conversation: recorded entries, a bounded model projection over them, one runner, and
optional fork lineage. A fork inherits a historical prefix; it does not receive the parent's later entries. A session
is not a resource or security boundary ([security-boundary.md](security-boundary.md)).

### What a sender's own session means

A person in a group has one session for the main timeline. Their follow-ups reach it, so a correction needs no
guessing about which task it belongs to. The cost is deliberate: in a group, Alice's request and Bob's request never
share context unless the context is read (below), and one person's unrelated second request joins their own running
task. Identical metadata can accompany "keep the old column" and "separately, check the weather"; no structural rule
tells them apart, and no model classifier is added. The executing agent reads the text and can ask.

### The message table and replying to an answer

The channel keeps a table of the platform messages that belong to a session: the asks it accepted for the session, with
the platform position each carries (Slack `ts`, Feishu `create_time` with the id, Telegram `message_id`), and what the
agent posted for it (answers and their chunks, stop feedback). Each session keeps the newest few asks, bounded like a
reply chain. Positions are read at ingress, where the channel already has them, so no key changes and no platform read
is added.

- A reply to one of those messages belongs to that session, whoever sends it, and is steered into it. Carol replying to
  Bob's answer ("what time?") reaches Bob's session, which holds the answer. Built (`kit/message-owners.ts`, Telegram
  and Feishu main timelines): the owner table is a bounded map from a platform message to its conversation (the
  newest 1000 messages), written when an ask is accepted and for every message the agent posts for a turn, each chunk of
  a long answer included. A `/stop` a reply carries stops its sender's own session, not the one replied to.
- A new thread or topic forks from the session that holds the message it was opened on, at that exchange's answer. When
  that message is not in the table, it starts empty and reads the place. Built for Feishu topics (`kit/thread-fork.ts`):
  only the replied-to message names a session, the rest of its reply chain is shown to the model but names nothing, and the
  room's read after a fork starts at that ask without leaving out the source's own answers, so the fork's answer is read
  again rather than a later one going missing. Telegram and Slack have no fork to make: a Telegram topic is created by a
  person, not by a reply, and a Slack thread is its own session.
- An id that is not in the table (another bot's message, or one from before the agent joined) names nothing.

The table is the only added state. An ask is written when it is accepted, before its send, and the agent's posts once
they are posted. It is a list of candidates and positions: whether an ask reached the session is the Agent's answer (see
the read below), not the table's.

## Input reaches a running session by steering

Every channel send uses `whenBusy: "steer"`. The Agent takes the message at the session's next step, after the current
tool calls, or at once when the session is idle (SPEC.md §5.3). Ordering and the queue limit belong to the Agent.

- A refusal (`queue_full`, capacity) is told to the asker, never dropped.
- The channel serializes **admission**, not execution: preparing a turn (downloading attachments, resolving the
  referent) and sending it happen in arrival order per session, so a slow download cannot reorder two sends. The wait
  for the answer does not hold the next send back.
- Steering does not undo an action already taken or prove the agent adopted the correction. An acceptance reaction means
  received, not completed.

Observed limits of steering (spikes below): a plain-text reply that answers an interjected question ends the run, and a
long task the interjection interrupted continues only if later input restarts it. This applies to one person
interleaving unrelated work into their own task, and to a reply steered into another sender's session. Both are accepted
consequences of the keys above.

## Shared context

A session does not hold what other sessions did. It reads the place.

| Information | Source |
|---|---|
| Slack and Feishu/Lark discussion and the agent's answers | Platform history, subject to access and retention |
| Telegram discussion the bot received and what it sent | Locally retained records; the Bot API has no history read |
| A thread's detail | The existing scoped thread tools (`slack-threads`, `feishu-threads`) |

Another session's answer is context, not redundancy: in a group, Alice's answer is exactly what Bob's session lacks.
Background is rendered into the user entry of the current request, attributed and separated from the instruction. It is
not a security guarantee against hostile content.

### Where a turn's read starts

A session already holds what an earlier turn of it folded, and the Agent is the record of it:

1. Take this session's newest asks from the table, newest first, and ask the Agent for each by `idempotencyKey`
   (`messages.get`). The first the Agent has, whatever its status, `queued` and not yet taken included, is the session's
   latest ask. Its stored position is the start. An ask the Agent does not have (the turn failed before its send) is
   skipped for the next older one. A session with none reads the place's newest messages.
2. Fold the place's messages after that position and up to this turn's own ask.
3. Leave out the messages the table gives to this session: its asks, and what the agent posted for it. They are in the
   session or its inbox already. A message the table gives to another session stays, as attributed discussion. Another
   session's ask is background, not an instruction, and another session's answer is the context this read exists for.

This replaces per-place cursors, recorded outputs and `peek/commit`. Whether a turn's ask was sent is read from the
Agent, so a failed turn that sent nothing advances nothing, and nothing is committed after an answer. The table cannot
put a start ahead of the session: it only offers keys. The agent's own posts are recorded after they are posted, so a
crash between the post and the record folds that one message once more; the fold says it is the agent's own.

A fork inherits its parent's entries but not the table, so its first read is the place's newest messages. A thread
reads its own messages, and the earlier room messages are read by the thread tools when needed. The reads happen after
the ingress acknowledgement.

The fold's budget (4000 characters) and truncation notice are unchanged. What the budget leaves out is said in the
text; it does not reach the model, and nothing retries it. The scoped thread tools are the way to read more.

### Limits to keep visible

- Available, discovered and included are different guarantees. A retained record can be unread, a discovered thread can
  be cut by the budget, included text can later be compacted.
- Bound a read to a position. A running request does not acquire later messages; a later tool read may, and says so.
- Group thread tools do not serve DMs, and Telegram has no equivalent. A DM's scoped lookup and a bounded lookup over
  Telegram's retained records are needed before either is claimed. Room-bound lookup stays room-bound; no tool takes an
  arbitrary chat id.
- Telegram's local records are its only copy. Retention bounds, persistence on each host and an observable missing-history
  result must be specified before long-term retrieval is promised.

## Answers, delivery and restart

### One answer for several inputs

Inputs steered into a running session can end with one shared answer; inputs taken after the run ended produce their
own.

| When an input is taken | Observed result | Delivery |
|---|---|---|
| While the run is going | Several messages share one `answer.entryId` | One message in the place's answer location |
| After the run ended | The idle session answers it on its own | Another answer; sending it with `steer` does not suppress it |

Each accepted input is tracked to its terminal result. Delivery is claimed per `(session, entryId)`: the first turn to
reach the answer delivers it, the others wait for that delivery and finish. Failures and cancellations without an
answer still reach their asker.

### What recovery needs

| State | Property |
|---|---|
| Accepted input, platform ids, references, answer location | Persisted before the ingress acknowledgement |
| Session of the input | Recorded before the first send; the idempotency key is stable, so a send of uncertain outcome is repeated, not duplicated |
| The generated answer, its `entryId` and what remains to deliver | Recorded before delivery; a restart delivers without running the model again |
| Answers already delivered, by `(session, entryId)` | Persisted, so recovering a second input of a shared answer does not send it again |
| Message-to-session table: asks with their positions, the agent's posts | Persisted before the ask's send and after each post |

The Agent's idempotency key is scoped to a session: sending the same platform input into another session repeats its
side effects. An interrupted unsafe tool is reported `interrupted` and not rerun. Platform delivery may still be
uncertain after a lost acknowledgement; this design does not claim exactly-once sends.

## Platform behavior

### Telegram

A private chat, a group and each forum topic are places. A group's main timeline is keyed by sender, a forum topic is
shared by its participants, and replies to the agent's answers follow the table above. Mentions and replies to the bot keep their summon behavior.

**Disabling privacy mode is a standard group-setup step**, not only a startup warning:

1. Guide the person through `@BotFather` → `/setprivacy` → select the bot → **Disable**.
2. For a bot already in a group, tell them to remove and re-add it for the change to take effect.
3. Check the global setting through `getMe.can_read_all_group_messages`; a failed check is reported as unknown.
4. Explain that the bot receives ordinary discussion as context but answers only under the summon policy.

A private-chat-only use is not blocked, and no administrator privilege is requested for receiving discussion. An
administrator bot is an exception to privacy filtering; the global flag does not prove what each group delivered.
Missing messages are never represented as heard.

Built: `channels setup telegram` reads the flag with the token's check and lists steps 1, 2 and 4 when the mode is on, or says Telegram did not report it; the serve's startup warning carries the same steps and says when `getMe` failed (`channels/telegram/privacy.ts` holds the one wording). Whether a particular group delivers everything is not checked.

The HTTP Bot API has no history listing, and disabling privacy mode changes incoming coverage, not retrospective access.
Undelivered updates are kept for at most 24 hours. MTProto's `messages.getMessages` and `channels.getMessages` let a bot
request known ids; they are not the current transport and have not been live-tested here. Sources:
[privacy mode](https://core.telegram.org/bots/features#privacy-mode),
[Bot API updates](https://core.telegram.org/bots/api#getting-updates),
[getMessages](https://core.telegram.org/method/messages.getMessages),
[channel messages](https://core.telegram.org/method/channels.getMessages).

### Slack

Channel asks are answered in their threads, following Slack's
[agent design guidance](https://docs.slack.dev/concepts/agent-design/#responses). A thread is a session shared by its
participants. [`chat.postMessage`](https://docs.slack.dev/reference/methods/chat.postMessage/) can post at top level or
use `reply_broadcast`; an explicit request to notify the channel may use them, and answer length alone does not choose a
location. Ordinary DMs follow DM continuity; the native Agent surface follows the conversations the user opens.
Cross-conversation context stays inside the DM and never imports private content into a channel.

### Feishu and Lark

An ordinary group's main timeline is keyed by sender; answers use the existing quoting and streaming-card behavior. In a
topic group, each topic is a session shared by its participants; the room view consists of topics' first posts. A new
topic forks from the session that holds the message it was opened on. `thread_id` identifies a topic; a changing reply-chain root does
not. Reading unsummoned discussion depends on platform scopes, and setup reports missing access. Lark shares the engine;
Feishu measurements are not live Lark validation.

## Why not the alternatives

| Alternative | Why not |
|---|---|
| One session per place, every input steered | Measured below: the answer to an interjected question ends the run; long work is lost, and one answer is shared by unrelated inputs |
| One session per place, with the agent answering through a send tool | Removes the blocking, but gives up the channel's delivery, previews and recovery, and depends on the model calling the tool |
| A table of exchanges that decides what a message continues | Needs an ownership rule that structure cannot supply, and a durable table of exchanges and bindings |
| A trunk session that absorbs every branch, or a router agent in front | A second job for one runner; the router contradicts one definition for every session |
| A new session per ask with no read | An agent that cannot use what was just said (participant-model.md §9) |
| A stored read cursor per reader | The session already records what it has read; a second record can disagree with it |

## Evidence and its limits

Local experiments on pi-durable with a faux model unless noted, and one real-model run. They test mechanics, not product
acceptance. The scripts are throwaway and not in the repository; the setups are described in the
[#989 discussion](https://github.com/fastagent-sh/fastagent/issues/989).

| Experiment | Observation |
|---|---|
| Decide to steer from `sessions.get` showing running, then send | Another input had taken the session in between: the decision and the send are not atomic |
| Six concurrent `whenBusy: "reject"` sends to an idle session, 50 rounds | Exactly one admitted each round, the rest `busy` |
| `reject` while a message is queued behind a finishing run | Never admitted in the gap between two messages |
| Six simulated exchanges, randomized timing, one shared session with steer | 306 of 600 model calls held input of two exchanges |
| Same, one session per exchange (never reused), and sessions reused under a lock with `reject` claims | 0 of 600+ model calls mixed exchanges, with wake-ups too. A sender's session behaves like an exchange's here; per-sender keys themselves were not run |
| Real model (`openai-codex/gpt-5.6-luna`), three inputs of different threads steered into one run, 3 repetitions per mode | The model kept the threads apart. A plain reply to the second input ended the run and the first input shared that answer; without a later restart only 1 or 2 of 5 migration steps ran |
| Same, with a send tool that answers each thread | No blocking and all five steps ran, but one final status answered all inputs, and the model chose to call the tool in every run of this sample |
| Supplement taken before versus after the original answer | One versus two distinct answer entry ids |
| One place cursor shared by two readers | A reader missed discussion the other had committed |
| 101 history messages under the fold budget | 13 included; the older update was omitted with a notice and never retried |
| Three threads read with no further session turn | A fork with a fresh read and an independent session with the same read both learned the sibling results |
| `SIGKILL` between recording a binding and sending, and during two unsafe tools | A stable session and key recovered without extra tool effects; changing them repeated an effect |
| Two forked sessions increment one file | Both succeeded; the parallel final value was 1, not 2 |

The real-model runs used one model, synthetic tools and local fixtures. They show nothing about other models, long or
side-effecting tasks, or real Slack, Feishu or Telegram payloads. Real Bedrock acceptance of steering's role sequences is
unverified.

The cross-session read was also tried with a real model: with only an old answer (Thursday) and no read tool it answered
Thursday after the humans had moved the date to Friday; with the thread tool it read the revision and answered Friday.
That small sample does not establish reliable retrieval or resistance to prompt injection.

### Provider caching

Cache reuse follows shared input prefixes, not the social identity of a conversation. pi-durable 1.5.0 gives forks fresh
provider identities; the public host callback `Harness.open({ conversationCreated })` can assign a fork its parent's
`ProviderDoc.sessionId`, with no pi patch. Adopting it globally affects every Caller using forks, and provider resources
sharing an identity must not be closed while another user needs them (#896). A small Codex comparison found a fork and
a reconstructed context both reusing a cache; it does not establish a winner. This design does not mandate one cache key
per place.

## Implementation boundary and acceptance

This proposal does not amend [SPEC.md](../SPEC.md). It uses the existing session, fork, send, steer, read and event
APIs; no merge or reset operation is added.

| Area | Responsibility |
|---|---|
| Channel adapters | Summon and placement policy, session keys from platform structure, message-to-session table, setup guidance |
| `conversation-sessions.ts` | Sessions per key; fork from the session holding the message a thread was opened on |
| `channels/kit/` turn lifecycle | Admission in arrival order per session, steer, shared-answer delivery, recorded outcomes |
| History readers and local records | The start of a read from the Agent's latest ask for the session, the fold and what it leaves out, scoped lookup tools |

Acceptance needs real platform payloads and the channel lifecycle for:

- keys for each platform's DM, group timeline and thread, including a reply to an old answer and a new topic;
- steering at the end of a run: shared and separate answers, every terminal outcome, crash recovery during delivery, a
  refused send reaching the asker;
- reads for a new session, a fork, a session whose newest message is a wake-up's or a schedule's, an ask still queued in
  the inbox when the next one arrives (including after a restart), the agent's own answers and stop feedback left out, a
  place longer than the budget, and an unreadable source;
- scoped DM lookup and Telegram retained-history lookup with concrete retention and persistence limits;
- Telegram privacy setup, already-added bots, administrator exceptions and unavailable checks;
- the declared limits on parallel tool side effects.

Model-intent error rates in real chats, long-thread retrieval quality and broader provider caching remain unmeasured.

Access control, personal continuity across places or hosts, proactive work and new chat commands are outside this
proposal. Scheduling and command behavior must not change as a side effect.
