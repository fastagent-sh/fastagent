---
title: Place history
description: "What a chat place said, read from the platform when a turn needs it, instead of copied into fastagent's own buffer: the source port, the shared fold, per-platform facts, and the plan."
type: design-doc
status: proposed
updated: 2026-10-07
---

# Place history

**Status: proposed, not implemented.** It replaces the context buffer as the source of "what was said in this
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
| Reading after a point | `start_time` (seconds), `sort_type=ByCreateTimeAsc` |
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
channels/kit/place-history.ts        engine-neutral, the only fold
  PlaceMessage   { id, at, sender: { kind: "human" | "agent" | "bot", id, name? }, text, replyTo?, attachments? }
  PlaceHistory   { read(place, { after?: Cursor, limit }): Promise<PlaceMessage[]> }
  recentDiscussion(history, place, marks) → { text, attachments, notes, next: Cursor }
  PlaceMarks     per place: the read cursor + the ids of the answers this channel delivered (a cache)

channels/feishu/history.ts           im/v1/messages (chat | thread), user_card_content, members → names
channels/slack/history.ts            conversations.history | conversations.replies
channels/telegram/history.ts         a local log: every message received + every message the agent sent
```

Considered: each channel doing it its own way. Then "since my last turn here" is derived three times, which is the
derivation that must not drift. The seam is where the platforms actually differ.

### The fold, `recentDiscussion`

1. Read the place's messages after its cursor.
2. **Drop the answers this channel delivered**, by message id. They are in the session already. The agent's other
   posts (a digest, a post into another chat) stay: they are what #633 is about. The drop is by id, not time: a
   message that arrives during a turn can be older than the answer that ends it.
3. Drop system messages. Label each sender: a human by name, `you (agent)` for this app, `bot <name>` for another.
4. Bound newest-first by a character budget. The agent's own posts get a larger per-message cap, because a digest is
   thousands of characters. What the budget cut is said ("N earlier messages not shown"), never dropped silently.
5. Advance the cursor when the turn's answer is delivered: the buffer's commit-on-`completed` rule, in place of
   consume-by-identity.
6. **A failed read is said**, in the prompt ("could not read the recent discussion here: …") and as a `warn`. The turn
   proceeds: context is not the ask.

**A lost cursor** (a deleted state file, a new instance) falls back to the place's last N messages. That costs
repetition the session may already hold, and never loses a message. This is the same contract as the participants
store in [participant-model.md](participant-model.md) §8: a cache may shape a prompt, never a durable claim.

### What it replaces, and what it does not

| Mechanism | After |
|---|---|
| Unsummoned discussion folded into the next answered turn (the buffer's main job) | `recentDiscussion` over `PlaceHistory` |
| A thread's first turn folding the room's discussion (rung 3, participant-model §8) | the same over the room's history, read-only: the room's cursor does not move |
| Summon rule (§3: humans heard in a thread) | **unchanged**: it is decided on the ACK path from pushed events, and §3 rejects platform reads there. These reads happen in the turn, after the ACK |
| Referent anchor (rung 2) and session inheritance (rung 4) | unchanged |
| Feishu/Slack `context-buffer.ts` and their `buffers.json` | removed |
| Telegram's buffer | stays: it is the only record a Telegram place has. `telegram-send` records what it sent into it through the shared `telegramTransport` (phase 1). Whether it later becomes a local `PlaceHistory` behind the same fold is decided once the fold exists |
| #374: the room reading a thread | an agent tool over the same `PlaceHistory`: list this room's threads, read one; bounded, the current room only |

## 4. Scopes

What Feishu needs is already granted by #748, except one scope:

- **`im:message.group_msg.include_bot:read` returns** with the phase that reads bot messages. It makes the platform
  push other bots' group messages (CI, alerts, deploy notices). The channel today drops every non-user sender, which
  is why #748 left the scope out. Phase 2 labels them `bot <name>` in the fold, keeps them out of the summon rule
  (a bot is not a second human), and requests the scope in the same change.
- Whether the **history read** returns other bots' messages without that scope is not measured (§6).

A tenant may withhold any of these. `checkAgentScopes` and the channel's startup name a missing scope with what it
costs (`FEISHU_AGENT_SCOPES`). Without `im:message.group_msg` the read is refused for groups. The fold then says "the
app cannot read this chat's history" instead of folding nothing.

## 5. Plan

| Phase | Scope | Done when |
|---|---|---|
| 1. Telegram's own posts | `telegramTransport`, shared by the channel and `telegram-send`, records what the agent sends into that chat's buffer (#754) | a schedule's post is in the chat's next answered turn |
| 2. Kit + Feishu / Lark | `place-history.ts` (the seam and the fold, built with its first async, platform-read source); Feishu `history.ts` over the measured API; names from members; bot messages labeled; `include_bot:read` requested; buffer removed | live: a digest sent with `feishu-send` is answered about without quoting it, in an ordinary and a topic group |
| 3. Slack | `history.ts`; buffer removed | the same, live |
| 4. Thread reading (#374) | the tool: list and read this room's threads | the #374 question set: a resolution a human wrote in a thread is found from the room |

Docs move with the phases: participant-model.md §2 (hearing vs knowing), §7 and §8 (rung 3's source);
core.md §7; feishu.md and slack.md "Group context".

## 6. Open questions

- **Other bots in Feishu's history read.** Does `im/v1/messages` list another bot's messages without
  `include_bot:read`? This decides whether the history read alone covers CI and alerts. To measure: a custom bot
  posting in a test group, read by the agent's app.
- **Latency from a host.** Every read above was measured from a laptop in China. A turn adds one read, and a thread's
  first turn adds two. Measure from Fly or AgentCore before choosing the budget and the page size.
- **Topic groups.** A topic group's chat history holds every topic's messages. "The room" there is the set of topic
  roots, and the fold must not pour every topic into one prompt. Decide whether a topic group has a room memory at
  all, or only its topics (participant-model §11 has the analogous Slack case).
- **Slack DMs.** Each assistant thread is its own place. Check that `conversations.replies` on an assistant thread
  returns what the user sees.
- **Lark.** The same API on `open.larksuite.com` is assumed, not measured.
