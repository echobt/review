# Contributing

## Submit results
1. Run your system over `datasets/<version>` at least `minRuns` times (see the rubric).
2. Add `submissions/<system>/<version>/submission.json`. It must validate against `schema/submission.schema.json`.
3. Open a PR. CI re-scores it and comments with the score. Self-reported scores are ignored.
4. Your entry is marked `verified` once a maintainer reproduces your score within ±2 stdDev and the held-out split has been scored.

## Propose a dataset case
Open a PR that adds the case to the next dataset version. The case needs a permissive license, real base and head SHAs, at least one labelled bug (or `bugs: []` for a clean PR), and a description of each bug. Every case gets a second, independent label before it is merged.

## Change the rubric
Open an RFC issue first. The PR must bump the version (semver) and include re-scored historical submissions. Changes stay open for comment for 14 days and need two maintainer approvals.
