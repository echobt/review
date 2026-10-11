# @review/client

Typed REST and SSE client for the review API. It is ESM only, and every request and response is checked with zod.

```ts
import { ReviewClient } from "@review/client";

const c = new ReviewClient({ baseUrl: "https://review.example.com", apiKey: process.env.REVIEW_API_KEY });
const review = await c.createReview({ kind: "diff", repositoryId: "repo", diff });
for await (const ev of c.reviewEvents(review.id)) console.log(ev.type);
const findings = await c.listFindings(review.id);
await c.createFeedback(findings[0].id, { verdict: "resolved" });
await c.putConfig({ maxComments: 10 }); await c.getConfig();
await c.createIndex({ repositoryId: "repo", commitSha }); await c.getIndex(id);
await c.createTestGen({ repositoryId: "repo", targetPaths: ["src/a.ts"] }); await c.getTestGen(id);
const job = await c.score({ reviewId: review.id, datasetCaseId: "sample-001" }); // ScoreJob
await c.getScore(job.id);
```

- **Retries:** GETs are retried on 429, 5xx and network errors, up to `maxRetries` times (default 3). Delays use full-jitter exponential backoff and honour `Retry-After`. POST and PUT are never retried. `sleep` and `random` can be injected for tests.
- **SSE:** if the stream drops before a `completed` or `error` event, the client reconnects once and sends `Last-Event-ID`.
- The API key goes only in the `Authorization: Bearer` header and is never logged.
