# FlakeHound plan

**Find it, explain it, fix it or quarantine it, automatically.**

FlakeHound ingests JUnit XML test results from every GitHub Actions run, detects flaky tests statistically, groups their failure signatures, explains the likely root cause with AI, and opens quarantine or fix PRs.

## Why

Flaky tests waste CI time and teach teams to ignore red builds. Paid tools (Trunk, BuildPulse, Mergify) are good but closed; open-source tools cover one framework. Nobody combines statistics, clustering, AI explanations and action in a free, cross-language tool.

## Functional requirements

MVP (launch 24 May 2027):

1. **Ingest:** a GitHub Action uploads JUnit XML plus run metadata (repo, workflow, job, run attempt, commit SHA, branch, runner OS) after each run.
2. **Parse:** JUnit XML from Jest, Vitest, pytest, Go (gotestsum), JUnit/Surefire, RSpec.
3. **Detect:** a test is flaky when it both passes and fails on the same commit (including reruns), or its flip rate across recent runs is significant. Score with Wilson intervals; require a minimum sample.
4. **Cluster:** group failures by normalised signature (strip numbers, paths, timestamps, hex ids from messages and stack frames).
5. **Explain:** for each new cluster, a guarded model call with the failure samples and the test source suggests a cause category (timing, ordering, shared state, network, randomness, resource) with confidence and evidence.
6. **Act:** PR comment ("known flaky, safe to rerun"), quarantine PR with an expiry date and tracking issue, or a fix PR for common patterns.
7. **Dashboard:** per-repo flakiness ranking, hours of CI wasted, trends.

Later: fix templates (fake timers, waits, isolation), Slack and Jira hooks, a public open-source flaky leaderboard.

## Non-functional requirements

| Area | Requirement |
| --- | --- |
| Accuracy | Statistical detection works with no model; AI is optional and always shows confidence |
| Cost | About 1 KB stored per test result; model calls only for new clusters |
| Privacy | Test names and traces only; source read inside the user's Actions |
| Scale | 1M test results per day on one small Postgres |

## Architecture

```
Action (upload) ─► ingest API ─► parse + normalise ─► store results ─► detector (stats) ─► clusterer ─► explainer (llm) ─► actions (comment, quarantine PR, issue)
```

Pure logic in `src/junit/`, `src/stats/`, `src/cluster/`, `src/quarantine/`; I/O on forge-core.

## Milestones

| Milestone | Target | Scope |
| --- | --- | --- |
| M0 Foundation | Feb–Apr 2027 (rotation) | Minimal XML parser, JUnit normaliser for 6 frameworks, Wilson scoring, flip detection, signature normaliser and clustering, quarantine file generators |
| M1 Service | May 2027 | Upload Action, ingest API, storage, detector job, PR comments |
| M2 Launch | 24 May 2027 | AI explanations, quarantine PRs, dashboard, launch |
