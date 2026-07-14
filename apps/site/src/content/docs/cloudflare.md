---
title: "Cloudflare deployment"
description: "How the public site and application are split on Cloudflare."
order: 3
---

The public site is a static Astro build deployed as Cloudflare Worker assets at `mayi.sh`. Its pages are built from Markdown in `apps/site/src/content`.

The application runs as a separate Worker at `app.mayi.sh`. It needs:

- a PostgreSQL database reachable through Hyperdrive;
- an R2 bucket for private artefacts;
- receipt signing keys and application secrets;
- a Cloudflare API token for automated deployments.

Keeping the two Workers separate means the landing page and documentation stay available even when the application is being deployed or its database is unavailable.

## Can it run for free?

Yes, while the project stays inside each provider's allowance. Cloudflare does not charge for static asset requests. Workers, Hyperdrive, and R2 each have free quotas, and a small Neon Free database can provide PostgreSQL.

The limits are independent. A traffic spike, a large artefact archive, or a busy database can move one service onto paid usage even when the others remain free. R2 also has to be activated in the Cloudflare dashboard before its free allowance is available.

For the exact production setup and required secrets, see the repository's [deployment guide](https://github.com/asiraky/mayi/blob/main/docs/DEPLOYMENT.md).
