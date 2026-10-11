# @review/scoring-client

Typed, credential-free client and **reference scorer** for the public scoring repo
[`echobt/code-review-scoring`](https://github.com/echobt/code-review-scoring) (see `docs/SCORING-PUBLIC.md`).

```ts
import { ScoringClient, scoreSubmission, Submission } from "@review/scoring-client";

const sc = new ScoringClient();                 // raw.githubusercontent.com/.../main
const rubric = await sc.rubric("1.0.0");
const dataset = await sc.dataset("sample-0.1");
const result = scoreSubmission(dataset, Submission.parse(json), rubric);
console.log(result.score, result.scoreStdDev);
```

`scoreRun` is the normative implementation of rubric v1.0.0: greedy one-to-one matching by descending confidence, same path, line ranges overlapping within `lineTolerance`.

## Checks

```sh
pnpm --filter @review/scoring-client typecheck   # tsc --noEmit, typescript@5
pnpm --filter @review/scoring-client test        # node:test
```
