# code-review-scoring

An open and reproducible way to score AI code reviewers. The score is computed from precision and recall against labelled bugs, weighted by severity, with a false-positive penalty. Latency and cost are reported alongside it. Every number on the leaderboard is recomputed by CI from the submitted raw findings.

- Rubric: `rubric/rubric.v1.0.0.json` (semver; changing it means a new leaderboard)
- Schemas: `schema/*.schema.json` (JSON Schema 2020-12)
- Data: `datasets/<version>/dataset.json` (`sample-0.1` is a synthetic placeholder)
- Results: `submissions/<system>/<version>/submission.json` feeds the generated `leaderboard/leaderboard.json`
- Reference scorer: `@review/scoring-client` (`scoreSubmission`)

See CONTRIBUTING.md to submit results or propose rubric or dataset changes.
