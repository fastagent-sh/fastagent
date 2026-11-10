---
title: Channel conversations and shared context
description: "Places provide shared context, exchanges determine message ownership, and Agent sessions carry execution: routing, concurrency, context reads, delivery and recovery across Telegram, Slack and Feishu/Lark."
type: design-doc
status: proposed
updated: 2026-11-10
---

# Channel conversations and shared context

**Status: proposed ([#989](https://github.com/fastagent-sh/fastagent/issues/989)). Not implemented.** This document
proposes replacing [participant-model.md](participant-model.md) Rule 3 and §6, and revising its thread-context and
platform mappings. The participant axiom and the distinction between hearing and answering remain. Answer placement
follows the platform defaults below. Current channel code and user guides still describe the shipped behavior.

The hard problem is letting one agent participate in several exchanges at once, use relevant information from the
others, and receive corrections without mistaking somebody else's discussion for instructions to its current task.

The design separates three responsibilities:

> **A place provides shared context. An exchange determines what a message continues. A session carries execution.**

All exchanges use the same agent definition. There is no separate router agent or worker role, no mandatory session
that absorbs every exchange, and no automatic merge of thread transcripts into a trunk. Existing default sessions,
forks, steering and history readers remain useful mechanisms.

## What people should experience

- One person's long task does not, by itself, hold up an independent question.
- A correction to ongoing work reaches that work at its next input boundary.
- Following up on an old answer continues the relevant exchange, not whatever its former session happens to be doing.
- A question can use relevant discussion from another exchange, including a human decision made after the agent's answer.
- Every accepted request has an observable outcome, including failures, and keeps its ownership across a restart.
- Answers stay attached to their questions. Internal execution choices do not move a conversation somewhere unexpected.

Hearing is not answering. The existing summon policy still decides whether a message starts or joins work. Reading a
thread's conclusion internally is also distinct from announcing it to the room; the latter remains a separate action.

## Places, exchanges and sessions

| Concept | Responsibility | Example |
|---|---|---|
| Place | The shared background available to conversations here | A Slack channel, a Feishu chat, a Telegram group or forum topic, a DM |
| Exchange | A request and its associated supplements, answers and follow-ups; it can span several turns | A migration and its corrections; a deployment-date question and later clarification |
| Session | The Agent's execution history, model context and serial runner | The session executing the migration |

A native thread usually supplies an exchange boundary. An explicit reply supplies a reference within that boundary.
Neither is a proof of intent: a thread can contain several requests, and a reply can ask about an old answer without
asking to change current work. Platform message ids, thread ids and Agent session ids remain different identities.

A FastAgent session is a pi-durable conversation: recorded entries, a bounded model projection over them, one runner,
and optional fork lineage. A fork inherits a historical prefix; it does not keep receiving the parent's later entries.
Compaction bounds the projection rather than guaranteeing verbatim recall. A session is not a resource or security
boundary ([security-boundary.md](security-boundary.md)).

An unthreaded timeline may retain a default session for sequential exchanges. That session is an execution convenience,
not the sole owner of the place's knowledge. An old exchange can remain associated with entries in it even after it
has started another exchange; following up then may require a fork. A stable logical exchange does not require every
future request to execute in the same physical session.

```text
place
├─ readable shared records: discussion, public answers, references, known work status
├─ exchange A → session executing its request and supplements
└─ exchange B → session executing its request and follow-ups

Each exchange can obtain relevant shared context without waiting for a special trunk to run.
```

### Why this ownership

| Approach | Trade-off |
|---|---|
| One executing trunk owns shared memory and absorbs all branches | Convenient history inheritance, but gives one runner a second responsibility: maintaining everyone's context |
| Shared records supply context to each exchange; sessions may be reused or forked | Keeps message ownership and context availability independent of which runner is busy; requires explicit read progress and reliable bindings |

The second is the design. It does not require deleting default sessions or creating an empty session for every message.
Experiments found that a fork with a fresh context read and an independent session with the same read both learned
sibling results without another trunk turn. That is evidence for separating responsibilities, not for banning trunks.

## From an incoming message to execution

```text
receive → persist accepted intent → determine exchange and answer location
        → select and record execution binding → prepare context → submit
        → observe actual outcomes → record answer and delivery state → deliver
```

Unaddressed discussion does not enter this execution path. It remains available as background to the extent the
platform delivered it or allows it to be read. Slow history reads belong after ingress acknowledgement, not on the
platform's acknowledgement deadline.

### Determine what the message continues

These are defaults for the first-party channels, applied after the summon decision:

| Signal | Default interpretation |
|---|---|
| A specific reply to a request or progress message being handled | Continue that exchange, regardless of sender |
| A specific reply to an earlier answer | Continue the referenced exchange, not another exchange running in the same session |
| An ordinary follow-up in an established native thread | Continue that thread's exchange |
| A new group-timeline ask with no reply relationship | Start a new exchange, even when the same sender has other work running |
| An ordinary message in an unthreaded DM | Continue the current conversation |
| A deliberately opened native conversation or side thread | Establish its exchange boundary, retaining the referenced background |

Adapters must distinguish a specific quote from an implicit thread root. Slack's `thread_ts` on every reply does not
mean every message explicitly targets the root's original request. If a thread is the answer location of an exchange,
its appearance does not create a second exchange for that same request. Membership does not switch merely because a
run finished before the next message arrived.

When a referent cannot be resolved, include the available reference and disclose the missing context. Do not invent a
binding to the sender's running task. For an explicitly separate thread, a parent reference supplies background rather
than silently redirecting its messages into the parent conversation. Platform normalization of these cases is part of
acceptance testing.

### Ambiguity is an accepted product choice

Identical sender, chat, thread and reply metadata can accompany both "keep the old column" and "separately, check the
weather." Structural routing cannot distinguish those intentions. The first version uses the defaults above rather
than a model classifier on every message. The executing agent interprets the text and can seek clarification.

In an unthreaded DM, successive messages therefore remain conversational: "use pnpm" can reach ongoing work, while an
unrelated question is not guaranteed a parallel run. In groups, sender identity alone never joins a new top-level ask
to ongoing work. Neither choice claims perfect intent recognition.

### Select execution without changing ownership

- An idle suitable session can execute the request.
- Input continuing its active exchange may use `whenBusy: "steer"`.
- An independent exchange gets a separate execution context when the suitable session is busy with other work. Fork
  related history when useful; otherwise assemble the required background for a new session.
- Capacity pressure delays the request without changing its exchange, answer location or a recorded execution binding.

For an old-answer follow-up, a fork can start at that answer's entry. For an independent ask, do not inherit an
unfinished request as another instruction to execute; use an appropriate completed prefix, or an empty session when
there is none. Known unfinished work can still be included separately as attributed status. A fork's historical
context is not a claim that no relevant change has happened since.

Selection and admission must prevent an unrelated exchange from taking over a session between the decision to steer
and the submission. The existing Agent API addresses `steer` to a session, not to an exchange or run id. A separate
busy-state read followed by a send does not prove this property. The admission protocol, including wake-ups or other
Callers using the session, must be verified before implementation is accepted; this document does not assume that
existing primitives already make that sequence atomic.

### Concurrency is not resource isolation

Sessions can run independently while their tools touch the same workspace, database or remote object. Two forked
sessions both successfully incremented a shared file in the spike, but the final value was one, not two. Resource
conflicts require a policy in the tools or execution environment; a channel must not promise that arbitrary parallel
writes are safe.

Keep the Agent's existing capacity protections. Additional scheduling limits, if needed, must count actual running
work across native threads and other contexts, not just a class named "side branches." No fixed three-branch quota is
part of this design. Queue feedback must be visible, and capacity exhaustion must never silently drop a request.

## Shared context and its sources

Shared context is assembled from existing records, not from a new complete copy of each platform's history.

| Information | Source |
|---|---|
| Slack and Feishu/Lark discussion and public answers | Platform history, subject to access and retention |
| Telegram discussion the bot received and messages it sent | Locally retained records; no general Bot API history read |
| Accepted, running, completed, failed or interrupted work | FastAgent's durable execution records |
| Which exchange, request and answer a platform message refers to | Channel-owned bindings |

The defaults extend [place-history.md](place-history.md): keep the exchange's execution history, load explicit
references, add necessary recent local discussion and relevant known work status, and read other threads when the
question needs their detail. A thread stays focused without being permanently cut off from later information.

Existing scoped thread tools are the starting point, not proof that every surface is covered. They currently serve
group turns, not DMs; Telegram has no equivalent platform history reader. Cross-conversation DM continuity requires a
scoped source for that DM, and Telegram needs a bounded lookup over retained records. Neither may be advertised as
implemented merely because group thread tools exist. Room-bound lookup remains room-bound; arbitrary chat ids are not
introduced as a shortcut.

### What "folding" means

The existing history fold renders selected background into the current request. It is **context preparation**, not
transcript merging or a guarantee of recall. For example:

```text
Background, not new requests:
  Migration exchange A: running; no completion has been recorded.
  Thread T2, 10:01, agent: deployment is scheduled for Thursday.

Current request:
  Dana: What is the agreed deployment day now?
```

The agent can read T2 and discover that people later changed the date to Friday. If the recent source already contains
that discussion, it can be included directly. The returned evidence should retain its source, speaker and time; an
old agent answer is not authoritative over later discussion just because it was produced by the agent.

The background lands in the session as part of this request's user entry. There is no separate passive write of a
user/assistant pair into another session. Attribution separates historical requests from the current instruction;
it is not a security guarantee against malicious content.

The first version does not automatically copy every answered exchange to a trunk, generate per-thread summaries, or
inject an activity digest for every thread. Reading a relevant thread worked in the small model experiment without
an extra activity cue. This supports starting with existing readers; it does not prove that models always choose to
read. Short complete background can also avoid an extra model/tool round.

### Availability, discovery and inclusion are different guarantees

A retained record can be available without being discovered. A discovered thread can be omitted from a bounded request.
Included text can later be compressed or misunderstood. The product must not collapse these into "the agent knows."

Readers must preserve these distinctions:

- Bound reads to an explicit source position or snapshot. Later tool reads may obtain newer information and should
  identify it as such; a running model request does not acquire future events automatically.
- Keep progress per reader and source. B reading a shared source cannot consume unread context for A. A fork may
  inherit read progress only when the corresponding context is actually within its inherited prefix.
- Suppress an output only when the receiving context already holds it. Another session's answer is not redundant
  merely because the same bot posted it. Inputs assigned to other exchanges are attributed background, not new work.
- Make late results discoverable at their publication position, rather than only at the older ask's position.
- Disclose truncation, access gaps and failed reads. Advancing a scan cursor past omitted text does not mean that text
  entered the model's context, and does not promise an automatic retry of the omitted material.
- Do not claim unbounded recall from bounded history tools. Long-thread listing, pagination and retrieval coverage
  require acceptance tests, especially for old roots with recent replies.

Retained source data and a disposable prompt cache have different lifetimes. Telegram's only local copy cannot be
silently evicted while promising later retrieval. Retention bounds, persistence on each host and an observable missing
history result must be specified before that promise ships. No infinite archive is implied.

## Platform behavior

### Telegram

A private chat, a group and each forum topic provide separate place scopes. Replies outside those topic boundaries
remain in the same timeline: the reply relationship can continue an exchange without creating a visible thread.
Group mentions and replies to this bot retain their existing summon behavior. A new unreferenced group ask is a new
exchange; an unthreaded private conversation defaults to continuity.

**Disabling privacy mode is a standard group-setup step**, not just a startup warning:

1. Guide the person through `@BotFather` → `/setprivacy` → select the bot → **Disable**.
2. For a bot already in a group, tell them to remove and re-add it for the change to take effect.
3. Check the global setting through `getMe.can_read_all_group_messages`; a failed check is reported as unknown.
4. Explain that the bot receives ordinary discussion as context but still answers only under the summon policy.

A private-chat-only use is not blocked. Do not ask for administrator privileges merely to receive discussion. An
administrator bot is an exception to privacy-mode filtering; the global flag alone does not prove what was delivered
in each group. Missing messages are never represented as heard.

This distinction is an API capability, not an extra group permission:

- The HTTP Bot API has no general chat-history listing. Disabling privacy filtering changes incoming message coverage,
  not retrospective access. Undelivered updates are retained for at most 24 hours.
- MTProto's `messages.getHistory` is user-only. Its `messages.getMessages` and `channels.getMessages` allow bots to
  request known ids, subject to access conditions. They are not the current FastAgent transport or a general history
  listing replacement; their use here has not been live-tested.

Sources: [privacy mode](https://core.telegram.org/bots/features#privacy-mode),
[Bot API updates](https://core.telegram.org/bots/api#getting-updates),
[getHistory](https://core.telegram.org/method/messages.getHistory),
[getMessages](https://core.telegram.org/method/messages.getMessages),
[channel messages](https://core.telegram.org/method/channels.getMessages).

### Slack

A channel is a shared context scope. A top-level ask and its answer thread are organized as one exchange from the
start: the first ask does not run in a mandatory channel trunk and then change ownership when someone follows up.
An existing thread keeps its answer location. Separate exchanges can progress independently, and any of them can read
relevant channel or thread history without waiting for a trunk turn.

Answering channel asks in their threads is the default, following Slack's
[agent design guidance](https://docs.slack.dev/concepts/agent-design/#responses). It keeps progress, answers and
follow-ups attached to the question and limits channel noise. It is not the only technical option:
[`chat.postMessage`](https://docs.slack.dev/reference/methods/chat.postMessage/) can post at top level or use
`reply_broadcast` to surface a thread reply. An explicit request to notify the channel may use those mechanisms;
answer length alone does not choose a different location.

Ordinary DMs default to conversational continuity; the native Agent surface follows the conversations the user opens.
Channel threading is not a rule that every private message creates a new exchange. Distinct native conversations can
obtain shared background within that DM through the scoped source described above. Thread placement does not limit
context to the thread, and cross-conversation context does not import private content into a public channel.

This is an official recommendation plus a proposed product default, not a claim of measured optimal UX.

### Feishu and Lark

An ordinary chat's main timeline may retain a default session for sequential exchanges. Independent work need not
wait behind it. Native topics provide exchange boundaries; answers remain in the chat or topic where asked, using the
existing quoting and streaming-card behavior.

In a topic group, the room-level view consists of topics' first posts; replies belong to their topics. Each topic can
progress independently and relevant topic history remains readable from the room's context scope. There is no need to
run a fictional top-level task solely to update shared memory.

Adapters distinguish an ordinary quote, an actual topic and a reply to an exchange's progress. `thread_id` identifies
a topic; a changing reply-chain root is not a substitute. An explicit old-answer reference does not steer unrelated
work now using its former session. Receiving and reading unsummoned group discussion still depends on the platform's
scopes; setup reports missing access. Lark shares the engine, but Feishu measurements are not live Lark validation.

## Answers, delivery and restart

### Observe the answer actually produced

`whenBusy: "steer"` delivers new input at the next eligible execution step, after current tool calls. It does not undo
an action already taken or prove that the agent adopted the requested change. An acceptance reaction or status means
received, not completed; use each platform's supported feedback rather than assuming all channels already have the
same reaction implementation.

The end-of-run race changes how many answers exist:

| When a supplement is taken | Observed Agent API result | Delivery obligation |
|---|---|---|
| While the original work is running | Both messages can reference the same `answer.entryId` | One shared answer in that exchange's answer location, not one duplicate per input |
| After the original work ended | The idle session takes an ordinary request and produces another answer | Deliver the additional answer; do not suppress it because the send used `steer` |

Track each accepted input to its actual terminal result. Group shared answers within their exchange and delivery
destination using answer identity, and retain the association to all covered inputs. Failures and cancellations without
an answer still need visible outcomes. Do not infer final delivery ownership from a pre-send busy check.

Record the generated answer and what remains to deliver before attempting platform delivery. Recovery must be able to
resume delivery without invoking the model again. A lost platform acknowledgement can still make delivery uncertain;
these experiments do not establish exactly-once platform sends.

### Keep decisions that recovery needs

| State | Required property |
|---|---|
| Accepted inbound intent, platform identity, references and answer location | Persist before ingress acknowledgement; do not lose an accepted ask |
| Exchange and execution binding, including the session and idempotency key | Record before the first Agent send; reuse after a send whose outcome is uncertain |
| Request outcomes, answer associations and pending delivery | Recover without assuming every input has its own answer |
| Context read progress and output exclusions | Separate readers; losing a cache may cause disclosed rereading, not reroute work |
| Retained local history where no platform read exists | Explicit retention and host-persistence limits; loss cannot be called a harmless cache miss |

An intent not yet bound can finish its initial selection after restart. Once bound, it must not be reassigned by
rerunning busy-state routing. Session creation precedes recording its binding, which precedes sending the message;
an unused empty session is preferable to a sent request with no recoverable binding.

The Agent's idempotency key is scoped to a session. Retrying the same platform input in a new session can repeat its
side effects. In the crash experiment, stable bindings kept two tool effects at two; changing the binding produced a
third. Unsafe interrupted tools were reported as `interrupted`, not rerun. A subsequent `completed` message meant the
model answered about that state, not that the interrupted operation had succeeded.

## A complete example

Alice asks for a migration, Bob asks for the deploy date, and Carol follows up. Assume each group message is addressed
to the agent as its platform requires.

| Event | Ownership, execution and context |
|---|---|
| Alice starts the migration | Exchange A owns the request, progress and answer location |
| Bob independently asks for the deploy date | Exchange B runs separately while A is busy; A's running status may be background, never a second migration instruction |
| Alice replies to A's progress: "keep the old column" | Input to A; delivered at the next input boundary, with its actual answer association observed |
| Carol replies to B's answer: "what time?" | Continues B's context, even though Carol was not its original sender |
| People later change the deployment from Thursday to Friday without calling the agent | The discussion remains in the available source; it is not an agent answer and cannot be captured by an answers-only log |
| Dana asks for the agreed deployment date | A new exchange uses available background and can read B's discussion, including the human revision; no special trunk has to run first |

On Slack, A and B are the threads beneath their top-level asks. In an ordinary Telegram or Feishu timeline, their
answers retain the platform's existing reply placement; a separate execution context need not create a visible topic.
In a native Feishu/Lark topic, follow-ups remain in that topic. The example establishes ownership and reading behavior,
not a guarantee that a model will always select the right source.

## Provider caching

Cache reuse follows shared input prefixes and provider behavior, not the social identity of a conversation. Forks can
reuse full history; independently assembled contexts can also reuse stable prefixes. Choose the context for correctness
before choosing its physical representation for cost.

pi-durable 1.5.0 gives forks fresh provider identities. The public host callback
`Harness.open({ conversationCreated })` can assign a fork its parent's `ProviderDoc.sessionId`; the spike verified
transitive inheritance while unrelated conversations remained distinct. This requires no pi patch. A request-body
extension hook is insufficient to cover identity used in headers and Codex's cached WebSocket.

Adopting that callback globally would affect every Caller using forks, not just channels. The scope of reuse must be
explicit. Provider resources sharing an identity must not be closed while another user still needs them; lifetime and
release ownership remain part of [#896](https://github.com/fastagent-sh/fastagent/issues/896). A finished message is not
the end of a session's lifetime. This document does not mandate one cache key for every session of a place.

## Evidence and its limits

The original [mechanism spike](https://github.com/fastagent-sh/fastagent/issues/989#issuecomment-6739985080),
[provider measurements](https://github.com/fastagent-sh/fastagent/issues/989#issuecomment-6758665587) and
[host callback check](https://github.com/fastagent-sh/fastagent/issues/989#issuecomment-6758851480) establish usable
building blocks. Follow-up local experiments exercised the failures below. These are design evidence, not a checked-in
channel acceptance suite.

### Mechanisms and fault injection

The follow-up used the real Agent API with controlled faux-model responses, actual SQLite for recovery, and a synthetic
platform-history source behind the real `createPlaceHistory`. Negative controls ran the unsafe policy and observed the
corresponding assertion fail. They test routing and state mechanics, not a real model's understanding.

| Experiment | Observation |
|---|---|
| Six pairs of messages with identical platform metadata but opposite intended routing | A structure-only rule cannot classify both members of a pair correctly; not a measured population error rate |
| Old-answer follow-up while the source session runs a migration | Session-only steering contaminated the migration's input and shared its answer; exchange-aware separation did not |
| Supplement before versus after the original answer | One versus two distinct answer entry ids; fixed suppression lost the late answer, per-input delivery duplicated the shared one |
| Three threads with no further trunk turn | Both fork-plus-fresh-read and independent-session-plus-read saw sibling results; inheritance alone did not |
| B commits its read before A, using one place cursor | A missed discussion only B had read; reader-specific progress preserved it |
| A result published at position 40 for an ask at position 2, after a reader passed 30 | Indexing by ask position hid the late result; publication position made it discoverable |
| 101 synthetic history messages under the current budget | 13 were included; an older important update was omitted, truncation was disclosed, and the next read did not retry it |
| Two forked sessions increment the same file | Both tools returned successfully; parallel final value 1, sequential final value 2 |
| `SIGKILL` after binding but before send, and during two unsafe tools with a pending steer | Stable binding recovered the requests without extra tool effects; rebinding repeated an effect; interrupted tools were reported |

The first spike's reopen test used an orderly close, while the follow-up actually killed a child process. Neither
verified the complete channel acknowledgement, delivery and redelivery path. Faux compaction demonstrated inclusion
of data in a summary request, not semantic summary quality. Real Bedrock acceptance of steering's role sequences is
still unverified.

### Real model context and caching

The context experiment used `openai-codex/gpt-5.6-luna`: three synthetic scenarios across four input/tool configurations,
12 answers. Thread tools returned local fixtures, not live Slack or Feishu history. With only an old Thursday answer
and no read tool, it answered Thursday after the humans had changed the date to Friday. With the tool available it
read the revision and answered Friday, both with and without an activity cue. Full short history answered Friday
without a tool call. Other scenarios covered unresolved proposals and historical requests as background; no synthetic
deployment action was called. This small sample does not establish reliable retrieval or prompt-injection resistance.

A separate cache comparison used about 6,700 input tokens, two alternating rounds and two concurrent first requests
per mode per round. Both modes explicitly reused their own warmed provider identity and stable reference prefix;
independent sessions do not currently inherit that identity automatically in FastAgent.

| Context construction | Requests with cache reads | Share of input tokens read from cache |
|---|---:|---:|
| Fork inherited history | 3/4 | 72.4% |
| Independent session reconstructed context | 4/4 | 97.0% |

All eight questions were answered correctly. One miss dominates this small comparison: it shows reconstructed context
can reuse a cache, not that it is superior or preserves all tool-history detail. Earlier Codex tests found substantial
benefit from sharing fork identity; a DeepSeek Flash sample hit cache with either identity. Anthropic was not measured.

## Implementation boundary and acceptance

This proposal does not amend [SPEC.md](../SPEC.md). Prefer the existing session, fork, send, steer, read and event APIs.
No merge or reset operation is introduced. If exchange-safe admission cannot be implemented over them, demonstrate the
gap and review the smallest contract change rather than silently weakening ownership.

| Area | Responsibility in this design |
|---|---|
| Channel adapters | Summon and placement policy, normalized thread/quote relationships, platform ids and setup guidance |
| `conversation-sessions.ts` and channel bindings | Stable exchange references and recorded execution selection; inspect the existing mapping before extending it |
| `channels/kit/` turn lifecycle and delivery | Admit work without a place-wide execution lock, observe shared answers, retain outcomes and delivery ownership |
| History readers, local records and scoped lookup tools | Reader-specific progress, attributed context, known work status and discoverable retained sources |
| Harness integration | Existing execution primitives and an explicitly scoped provider-identity optimization with safe cleanup |

Implementation is accepted only after real platform payloads and the channel lifecycle cover:

- specific old replies versus implicit thread roots, native conversation creation and ordinary DM continuation;
- exchange-safe admission around completion, including other Callers and wake-ups using a session;
- shared and separate answers at the steer boundary, all terminal outcomes, and crash recovery during delivery;
- late results, inherited read progress, dropped context, long active threads and explicit unreadable-source behavior;
- scoped DM lookup and Telegram retained-history lookup, with concrete retention and deployment-persistence limits;
- Telegram privacy setup, already-added bots, administrator exceptions and unavailable checks;
- capacity feedback without reassignment, plus the declared limits on parallel tool side effects.

These checks still need end-to-end Telegram, Slack, Feishu and Lark validation. Model intent error rates in real chats,
long-thread retrieval quality and broader provider caching remain unmeasured. The current group readers and the local
spikes do not establish those results.

Access control, personal continuity across places or hosts, proactive work and new chat commands are outside this
proposal. Existing security checks remain in force. Current scheduling and command behavior must not silently change
as a side effect of session reuse or splitting; any required integration decision is reviewed separately.
