---
title: "Introduction"
description: "What May I? does and where it sits in an agent workflow."
order: 1
---

May I? is an approval service for software agents. The agent describes an exact action, a person approves or denies it, and the service issues a signed receipt for approved requests.

The executor still owns enforcement. Before it deploys, deletes, transfers, or calls an external API, it verifies that the receipt matches the action it is about to perform.

## The flow

1. An agent creates a draft with an action, explanation, expiry, and enforcement mode.
2. It uploads any supporting evidence and seals the request.
3. An eligible person reviews the frozen request in the web or mobile app.
4. May I? records the decision and issues a short-lived receipt when approved.
5. The executor verifies the receipt and consumes it when one-time enforcement is required.

Every application ID is a 12-character NanoID containing ASCII letters only.
