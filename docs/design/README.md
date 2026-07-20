---
title: Design notes
description: "What belongs in FastAgent's public design notes, and what is normative: the Agent Handler SPEC, the code, and the user docs."
status: current
---

# Design notes

This directory contains maintainer-facing design material. It is intentionally kept separate from the user guide so people evaluating or using FastAgent can follow the short path first: [Quickstart](../quickstart.md), [Embedding](../embedding.md), and [Channels](../channels.md).

## What is normative?

| Source | Status |
|---|---|
| [Agent Handler SPEC](../SPEC.md) | Normative protocol contract. Changes require explicit review. |
| Code in `src/` | Implementation source of truth. |
| User docs in `docs/` | Product behavior and supported usage. |
| Documents in `docs/design/` | Explanatory architecture notes. They clarify why the code is shaped the way it is, but they are not a public compatibility promise. |

## What belongs here?

Keep public design notes only when they help contributors make better changes:

- architecture decisions that are visible in the code,
- tradeoffs that are not obvious from implementation alone,
- constraints reviewers should preserve when changing the system.

Do **not** keep private strategy here: market positioning, competitor analysis, pricing, launch plans, partner/customer notes, and internal risk analysis belong in a private workspace. Temporary plans, handoff notes, session logs, and stale debates should be deleted or folded into durable public docs.

## Documents

| Document | Purpose |
|---|---|
| [core.md](core.md) | Current architecture of the pi reference implementation. |
| [session-control.md](session-control.md) | Session control plane beside `invoke`: observation plane shipped; control plane (dispatch) proposed. |
