# @review/sdk

High-level SDK on top of `@review/client`.

| Function | What it does |
|---|---|
| `reviewPullRequest(repoId, prRef)` | starts a PR review, streams events, resolves with the completed `Review` |
| `reviewDiff(repoId, diff, baseSha?)` | same, for a raw unified diff |
| `indexRepo(repoId, sha, incremental?)` | requests a (incremental) repository index |
| `generateTests(repoId, paths, opts?)` | starts a sandboxed test-generation run |
| `scoreReview(reviewId, datasetCaseId)` | scores a review against a public dataset case |

```ts
import { ReviewSdk } from "@review/sdk";

// Auth: options.apiKey > REVIEW_API_KEY > file at REVIEW_API_KEY_FILE. Base URL: options.baseUrl > REVIEW_API_URL.
const sdk = new ReviewSdk({ onEvent: (e) => console.log(e.type) });
const review = await sdk.reviewPullRequest("repo-1", { provider: "github", owner: "acme", repo: "api", number: 42 });
console.log(review.findings.length);
```

No secrets are bundled; keys come from env or a secret file mounted at runtime.

## Checks

```sh
pnpm --filter @review/sdk typecheck   # tsc --noEmit, typescript@5
pnpm --filter @review/sdk test        # node:test
```
