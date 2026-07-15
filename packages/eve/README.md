# `@mayi/eve`

Durable Mayi approval channel for [Eve](https://github.com/vercel/eve) agents.

```sh
npm install @mayi/eve eve
```

```ts
// agent/channels/mayi.ts
import { mayiChannel } from "@mayi/eve";
import { credentials } from "../credentials.server";

export default mayiChannel({
  getAccessToken: () => credentials.getAccessToken("mayi"),
});
```

The deployment host provisions `EVE_PUBLIC_ORIGIN`, `MAYI_CALLBACK_STATE_KEY_ID`, and a stable base64url-encoded 32-byte `MAYI_CALLBACK_STATE_KEY`. The author does not construct callback URLs, store correlation records, or provide a static Mayi API key.

The package is ESM-only, supports Node.js 24 and later (matching Eve), and pins its Eve peer to the tested `eve@0.24.2` contract.

Licensed under the [Apache License 2.0](LICENSE).
