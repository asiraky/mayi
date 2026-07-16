---
title: "Introduction"
description: "What May I? does and where it sits in an agent workflow."
order: 1
---

May I? is a human-in-the-loop service for software agents. At any point where an agent needs a person — a yes or no on an exact action, a pick from a list of options, a freeform answer — it files the question with May I?, parks, and resumes when the answer arrives. Every resolution is delivered as a signed event.

Approvals are the receipt-bearing kind of ask. The agent describes an exact action, a person approves or denies it, and the service issues a signed receipt for approved requests. The executor still owns enforcement: before it deploys, deletes, transfers, or calls an external API, it verifies that the receipt matches the action it is about to perform.

The other kinds — select and freeform text — go through the inputs API (`POST /api/inputs`). They carry no enforcement, because there is no action to gate, but every answer still mints a durable signed attestation of who answered, what, and when.

## The approval flow

1. An agent creates a draft with an action, explanation, expiry, and enforcement mode.
2. It uploads any supporting evidence and seals the request.
3. An eligible person reviews the frozen request in the web or mobile app.
4. May I? records the decision and issues a short-lived receipt when approved.
5. The executor verifies the receipt and consumes it when one-time enforcement is required.

## The input flow

1. An agent posts a question — text, select, or confirmation — with a prompt, expiry, and optional callback.
2. An eligible person answers it in the web or mobile app.
3. May I? records the answer, mints a signed attestation, and delivers a signed `input.resolved` event to the callback. Agents without a callback poll instead.
