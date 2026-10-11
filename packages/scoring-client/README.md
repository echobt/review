# @review/scoring-client

Typed client and reference scorer for the public scoring repo (`docs/scoring/`, mirrored at echobt/code-review-scoring). It needs no credentials.

```ts
import { ScoringClient, scoreSubmission, runMetrics, buildLeaderboard, regressionGate, matchWithJudge, LlmJudge } from "@review/scoring-client";

const sc = new ScoringClient();                       // or { baseUrl, fetch }
const rubric = await sc.rubric("1.0.0");
const dataset = await sc.dataset("sample-0.1");

const result = scoreSubmission(dataset, submission, rubric);          // { score, scoreStdDev, runs[] }
const { metrics } = runMetrics(dataset, results, rubric, feedback);   // + f05, acceptanceRate, resolutionRate

const lb = buildLeaderboard([{ submission, result, path: "submissions/x/submission.json", verified: false }]);
const { pass, reasons } = regressionGate(baseline, candidate, { maxScoreDrop: 1, maxSwrDrop: 0.02, maxPrecisionDrop: 0.02 });

// Optional: let a judge decide only same-path near-misses (default scoring stays deterministic).
const judged = await matchWithJudge(dataset, results, rubric, new LlmJudge(router), { nearMissLines: 20 });
```

- The composite score is rubric v1.0.0's weighted geometric mean of SWR, precision and the FP/PR term. F0.5, latency p50/p95, cost and the feedback rates are reported next to the score; they are not part of it.
- `Judge` is `{ judge(bug, finding): Promise<{ match, confidence }> }`. `DeterministicJudge` always answers no. `LlmJudge` accepts anything that has a ModelRouter-like `json()` method.
