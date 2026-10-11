# @review/core

Shared, I/O-free contracts for the review platform: `Finding`, `Review`, `Severity`, `Rule`, `RepoIndex`, `TestGenRun`, `ScoreReport`, the REST API request/event schemas (`api.ts`) and the inter-service queue messages (`messages.ts`). All are zod schemas; the TypeScript types are inferred from them.

```ts
import { Finding, parseMessage, routes } from "@review/core";

const f = Finding.parse(untrusted);            // throws ZodError on invalid input
const msg = parseMessage("review.requested", job.data); // tenant-scoped envelope + payload
console.log(routes.createReview);              // { method: "POST", path: "/v1/reviews" }
```

## Checks

```sh
pnpm --filter @review/core typecheck   # tsc --noEmit, typescript@5
pnpm --filter @review/core test        # node:test
```
