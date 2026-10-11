# @review/client

Typed REST + SSE client for the platform API. Requests are validated before any I/O; responses are validated with the `@review/core` schemas, so a server drift fails loudly.

```ts
import { ReviewClient, ReviewApiError } from "@review/client";

const client = new ReviewClient({ baseUrl: "http://localhost:8080", apiKey: process.env.REVIEW_API_KEY });
const review = await client.createReview({ kind: "diff", repositoryId: "repo-1", diff });
for await (const ev of client.reviewEvents(review.id)) console.log(ev.type);
```

Errors: non-2xx responses throw `ReviewApiError { status, code }`. The API key is only sent as a bearer header, never logged.

## Checks

```sh
pnpm --filter @review/client typecheck   # tsc --noEmit, typescript@5
pnpm --filter @review/client test        # node:test
```
