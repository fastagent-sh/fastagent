---
title: Place history
description: "What a chat place said, read from the platform when a turn needs it, instead of copied into fastagent's own buffer: the source port, the shared fold, per-platform facts, and the plan."
type: design-doc
status: in progress
updated: 2026-10-07
---

# Place history

**Status: phase 2 (Feishu/Lark) implemented. Phase 1 (Telegram's own posts) is in review (#754); Slack and thread
reading are proposed.** It replaces the context buffer as the source of "what was said in this
place" for Feishu/Lark and Slack, and keeps a local record for Telegram, whose Bot API has no history read.
It answers two issues together:

- **#633.** An agent does not know what it posted proactively, for example a schedule's digest sent with
  `feishu-send`, when someone asks about it in that chat without quoting it.
- **#374.** A room does not know what was concluded in one of its threads.

Both are the same gap: the place's history is not where the agent looks.

## 1. The rule

> **The platform is the place's memory. The session is the agent's.**

| | What it is | Who keeps it |
|---|---|---|
| Session | what the agent saw and said in its own turns | fastagent (SPEC MUST 6: durable, location-independent) |
| Place history | everything said in a chat or a thread | the platform, where it can be read; fastagent only where it cannot |

The context buffer (`channels/kit/context-buffer.ts`) is a partial copy of the second:

- It holds only what the platform pushed. A mention-only app receives nothing unsummoned.
- It never holds the agent's own proactive posts. That is #633.
- It never holds a thread's discussion from the room's side. That is #374.
- It never sees edits or recalls.
- It carries every cost of a cache: a character budget, eviction, one writer per file (a second process
  overwrites it), and a cold AgentCore microVM whose channel was never constructed.

Read from the platform, the agent's digest is already in the chat's history, and a thread is one read away. Nothing
is folded or pushed, which [participant-model.md](participant-model.md) §7 and #374's discussion rejected.

## 2. Measured facts

Measured on 2026-10-07 with read-only calls, except for a handful of `spike test` posts in test groups.

### Slack (`conversations.history` / `conversations.replies`)

| Question | Answer |
|---|---|
| Scopes | `channels:history`, `groups:history`, `im:history`, `mpim:history`: in every app's manifest since #748 |
| The agent's own posts | present: `bot_id` and `user` equal `auth.test`'s ids |
| Humans / other bots | humans have `user` and no `bot_id`; another bot has a different `bot_id` |
| System messages | `subtype` (`channel_join`, …), to be dropped |
| Threads | the channel history holds each thread's root with `reply_count`; `conversations.replies` returns the root plus every reply, the agent's answers included |
| Reading after a point | `oldest` + `inclusive=false` |
| Rate limit | Tier 3 (50+/min) for an app built for its own workspace, which is what `add slack` creates. The 2025 limit of 1/min and 15 messages applies only to commercially distributed non-Marketplace apps |
| Latency from a laptop in China | history 550–640 ms, replies ~320 ms. Not measured from a deployed host |

### Feishu (`GET /open-apis/im/v1/messages`)

| Question | Answer |
|---|---|
| Scopes | `im:message:readonly` plus `im:message.group_msg` for group chats; both in every created app since #748 |
| The agent's own posts | present: `sender.sender_type = "app"`, `sender.id` = the App ID |
| Channel answers | every answer has `parent_id` = the message it answered, `root_id` = its thread's root |
| **Cards (Card 2.0)** | by default the body is a placeholder ("请升级至最新版本客户端，以查看内容"). **`card_msg_content_type=user_card_content` returns the card's markdown**, a streamed answer's final text included. Without it a `feishu-send` markdown digest is unreadable |
| System messages | `msg_type = "system"`, empty sender |
| **Ordinary group** | the chat's history holds a thread's root only; its replies are not in it. `container_id_type=thread` with the `thread_id` returns root plus replies |
| **Topic group** (`chat_mode = "topic"`) | the chat's history holds **every** message, each with its `thread_id`. A proactive post there opens a topic of its own |
| Reading after a point | `start_time` is in seconds and inclusive, so it is not Slack's `inclusive=false`: as a cursor it would re-read the cursor's own second every time. The channel lists newest first (`ByCreateTimeDesc`, one page of 50, `end_time` at the ask's second) and stops at the cursor, a `(create_time ms, message_id)` pair |
| **Other bots** | listed in the history read, `sender_type = "app"` with their App ID, without `include_bot:read` |
| Names | events and history carry open_ids only; `GET /im/v1/chats/:id/members` (`im:chat.members:read`, in every created app since #748) maps them to names |
| Rate limit | 1000/min, 50/s |
| Latency from a laptop in China | 310–410 ms per read |

### Telegram

The Bot API has **no history read**. An update is delivered once; unfetched updates expire after 24 hours. With group
privacy mode off, or as an admin, a bot receives every human message. It never receives its own messages, and
receives other bots' messages only with Bot-to-Bot Communication Mode. Its record of a place is therefore whatever it
kept, plus what it sent.

## 3. Architecture

One seam (where a place's messages come from) and one shared fold (what of them reaches a turn):

```
channels/kit/place-history.ts        engine-neutral
  DiscussionSource<E> { peek(place) → { text, consumed: E[] } (sync or async, never rejects); commit(place, consumed) }
  PlaceMessage        { id, at, from: { kind: "human" | "self" | "bot", label }, text, replyTo?, images, files }
  foldPlace(messages, earlier) → { text, folded }   the one budget and label format

channels/kit/context-buffer.ts       a DiscussionSource over pushed messages (Telegram, Slack until phase 3)
channels/feishu/history.ts           a DiscussionSource over im/v1/messages (chat | thread), user_card_content,
                                     members → names, a per-place cursor in history.json
channels/slack/history.ts            phase 3: conversations.history | conversations.replies
```

The turn runner sees only `DiscussionSource`: it peeks when a turn runs and commits what it peeked when the turn's
answer is recorded, whichever source is behind it.

Considered: each channel doing it its own way. Then "since my last turn here" is derived three times, which is the
derivation that must not drift. The seam is where the platforms actually differ.

### The fold (Feishu, `history.ts` + `foldPlace`)

1. Read the place's messages after its cursor **and up to the turn's own ask** (`end_time` server-side, then
   `(create_time, message_id)`). With no cursor, the newest 20 before the ask. The cursor then moves to the ask. The
   bound is what keeps this turn's ask, an ask queued behind it in the same session (its own turn: folding it here
   would answer it twice) and anything said after it out of this turn; it needs no record of which messages were asks,
   so a cold instance or a lost state file cannot break it. (Slack, in phase 3: `latest`.)
2. **Drop what the session holds**, by message id: every message a turn posted into the place (answers, queue notices,
   stop feedback) and, as prompt shaping only, what the channel took as input (`seen.json`: a `/stop`). The first is recorded per place, beside its cursor in `history.json`, by a client the turn posts
   through (`FeishuApi.recordingSends`), and forgotten once a read has passed it: a shared bounded ring would let a
   busy deployment evict a quiet place's last answer. `feishu-send` shares the plain client, so the agent's other
   posts (a digest, a post into another chat) stay: they are what #633 is about.
   The drop is by id, not time: a message that arrives during a turn can be older than the answer that ends it.
3. Drop system and deleted messages. Label each sender: a human by name, `you` for this
   app, `bot <app_id>` for another.
4. Bound newest-first by a character budget, so the discussion closest to the ask is what survives. The agent's own
   posts get a larger per-message cap, because a digest is thousands of characters. What the budget cut is said
   ("N earlier messages not shown"), and so is what the read never reached ("earlier messages not shown", without a
   count: counting would mean reading every page), never dropped silently.
5. Advance the cursor when the turn's answer is recorded (`onAnswered`, before it is delivered), and only forward:
   turns in a place can finish out of ask order (a redelivered ask, a deferred turn), and an earlier ask's commit must
   not pull the cursor back over what a later turn already folded. This is the buffer's
   commit-on-`completed` rule, in place of consume-by-identity. An answer that is then not delivered is re-delivered
   from the turn store, not re-run, so its discussion is not owed to another turn.
6. **A failed read is said**, in the prompt ("could not read the recent discussion here: …") and as a `warn`. The turn
   proceeds: context is not the ask.

**A lost cursor** (a deleted state file, a new instance) falls back to the place's last N messages. That costs
repetition the session may already hold (the agent's earlier answers among them, labelled `you`), and never loses a
message. This is the same contract as the participants
store in [participant-model.md](participant-model.md) §8: a cache may shape a prompt, never a durable claim.

### What it replaces, and what it does not

| Mechanism | After |
|---|---|
| Unsummoned discussion folded into the next answered turn (the buffer's main job) | `foldPlace` over a platform read, behind `DiscussionSource` (Feishu: `createFeishuPlaceHistory`) |
| A thread's first turn folding the room's discussion (rung 3, participant-model §8) | the same over the room's history, read-only: the room's cursor does not move |
| Summon rule (§3: humans heard in a thread) | **unchanged**: it is decided on the ACK path from pushed events, and §3 rejects platform reads there. These reads happen in the turn, after the ACK |
| Referent anchor (rung 2) and session inheritance (rung 4) | unchanged |
| Feishu/Slack `context-buffer.ts` and their `buffers.json` | removed |
| Telegram's buffer | stays: it is the only record a Telegram place has. `telegram-send` records what it sent into it through the shared `telegramTransport` (phase 1, #754). The buffer is already a `DiscussionSource`; whether it also renders through `foldPlace` is decided when #754 lands |
| #374: the room reading a thread | an agent tool over the same platform reads: list this room's threads, read one; bounded, the current room only |

## 4. Scopes

What Feishu needs is already granted by #748. `im:message.group_msg.include_bot:read` stays out: it only makes the
platform push other bots' group messages as events, which the channel drops (a bot neither summons the agent nor
counts as a second human), and the history read lists them without it (§2).

A tenant may withhold any of these. `checkAgentScopes` and the channel's startup name a missing scope with what it
costs (`FEISHU_AGENT_SCOPES`). A read the platform refuses costs the turn its discussion, not the turn: the prompt
says "could not read the recent discussion here: <the platform's error>" instead of folding nothing.

## 5. Plan

| Phase | Scope | Done when |
|---|---|---|
| 1. Telegram's own posts | `telegramTransport`, shared by the channel and `telegram-send`: its send methods, which only `telegram-send` calls, record what they send into that chat's buffer. The channel's answers go out through its own preview path and are not recorded: they are in the session. The buffer has one writer, the mounted channel; a send from a process with no channel mounted (`fastagent tool`, `invoke`) is delivered but not recorded, and the tool's result says so. Where channel state does not persist (AgentCore, no volume) the buffer itself does not, so this holds only within one instance's life (#754) | a schedule's post is in the chat's next answered turn, where the schedule fires in the serving process |
| 2. Kit + Feishu / Lark | `place-history.ts` (the seam and the fold, built with its first async, platform-read source); Feishu `history.ts` over the measured API; names from members; bot messages labeled; buffer removed | live: a digest sent with `feishu-send` is answered about without quoting it, in an ordinary and a topic group |
| 3. Slack | `history.ts`; buffer removed | the same, live |
| 4. Thread reading (#374) | the tool: list and read this room's threads | the #374 question set: a resolution a human wrote in a thread is found from the room |

Docs move with the phases: participant-model.md §2 (hearing vs knowing), §7 and §8 (rung 3's source);
core.md §7; feishu.md and slack.md "Group context".

Decided in phase 2: a topic group's room is its topics' first posts. Its chat history holds every topic's replies too
(§2), and a reply belongs to its topic's place, so the room's read drops messages that are replies inside a thread.

## 6. Open questions

- **Latency from a host.** Every read above was measured from a laptop in China. A turn adds one read, and a thread's
  first turn adds two. Measure from Fly or AgentCore before choosing the budget and the page size.
- **Slack DMs.** Each assistant thread is its own place. Check that `conversations.replies` on an assistant thread
  returns what the user sees.
- **Lark.** The same API on `open.larksuite.com` is assumed, not measured.
