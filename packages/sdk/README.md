# @review/sdk

High-level SDK built on `@review/client`.

```ts
import { ReviewSdk, verifyWebhookSignature } from "@review/sdk";

const sdk = new ReviewSdk({ baseUrl: "https://review.example.com", onEvent: (e) => console.log(e.type) });
const review = await sdk.reviewPullRequest("repo", { provider: "github", owner: "o", repo: "r", number: 1 });
await sdk.reviewDiff("repo", diff);
await sdk.indexRepo("repo", commitSha);
await sdk.generateTests("repo", ["src/a.ts"]);
const report = await sdk.scoreReview(review.id, "sample-001"); // polls until the ScoreReport is ready

// Webhooks: verify against the exact raw body.
if (!verifyWebhookSignature(secret, rawBody, req.headers["x-hub-signature-256"])) return res.status(401).end();
```

- **Auth:** the key comes from the `apiKey` option, then `REVIEW_API_KEY`, then the file at `REVIEW_API_KEY_FILE`. The base URL comes from `baseUrl` or `REVIEW_API_URL`.
- **`scoreReview`:** waits 250ms between polls and doubles the wait up to 5s. It gives up after `scoreTimeoutMs` (default 120s). `sleep` can be injected.
