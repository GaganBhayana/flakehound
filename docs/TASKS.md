# FlakeHound tasks

Status values: `todo`, `review (PR #n)`, `done (PR #n)`, `blocked: <reason>`. Sizes: S (under 150 lines changed), M (150–400). One task per PR. M0 tasks are pure logic with no I/O.

## M0 Foundation

### FH-001 Minimal, safe XML parser
- Status: done (PR #1)
- Size: M
- Depends on: none
- Goal: `src/xml/parse.ts`: a small non-validating XML parser for test reports: elements, attributes, text, CDATA, comments, the five predefined entities and numeric character references. Rejects DOCTYPE and external entities (no XXE), caps depth (default 64) and input size.
- Acceptance: tests for each construct, malformed input errors with line numbers, DOCTYPE rejection, depth limit.

### FH-002 JUnit XML to normalised results
- Status: done (PR #2)
- Size: M
- Depends on: FH-001
- Goal: `src/junit/normalise.ts` maps `<testsuites>/<testsuite>/<testcase>` with `<failure>`, `<error>`, `<skipped>`, `system-out` into `TestResult {id, suite, name, file?, status: passed|failed|error|skipped, durationMs, message?, stack?}`. Stable `id` from suite + name + file.
- Acceptance: fixtures in the shapes produced by Jest (jest-junit), Vitest, pytest, gotestsum, Surefire and RSpec (written for tests), each with expected output.

### FH-003 Run metadata model
- Status: todo
- Size: S
- Depends on: FH-002
- Goal: `src/model.ts` with `RunMeta {repo, workflow, job, runId, attempt, sha, branch, os, startedAt}` and `Observation {meta, result}`; validators for upload payloads.
- Acceptance: tests for valid and invalid payloads.

### FH-004 Wilson score interval
- Status: todo
- Size: S
- Depends on: none
- Goal: `src/stats/wilson.ts` computes the Wilson interval for a failure proportion at a given confidence.
- Acceptance: tests against known values (for example 5 failures in 100 at 95%), edge cases n=0 and p=0 or 1.

### FH-005 Flaky detection
- Status: todo
- Size: M
- Depends on: FH-003, FH-004
- Goal: `src/stats/detect.ts` labels each test `stable|flaky|broken|insufficient-data` from observations: same-SHA pass and fail means flaky; otherwise use flip rate and the Wilson lower bound with configurable thresholds and minimum runs.
- Acceptance: table tests covering reruns on one SHA, a consistently failing test (broken, not flaky), and low samples.

### FH-006 Failure signature normaliser
- Status: todo
- Size: S
- Depends on: FH-002
- Goal: `src/cluster/signature.ts` normalises messages and top stack frames: replaces numbers, hex ids, UUIDs, temp paths, timestamps and ports with placeholders; keeps the first N in-repo frames.
- Acceptance: tests show two runs of the same failure map to one signature and different failures don't.

### FH-007 Clustering failures
- Status: todo
- Size: S
- Depends on: FH-006
- Goal: `src/cluster/group.ts` groups failures per test by signature, with counts, first/last seen and sample ids.
- Acceptance: tests with three failure modes for one test.

### FH-008 Flakiness ranking and wasted-time estimate
- Status: todo
- Size: S
- Depends on: FH-005
- Goal: `src/stats/rank.ts` ranks flaky tests by impact (failure rate × runs × job duration) and estimates CI minutes wasted on reruns.
- Acceptance: tests with a small synthetic history.

### FH-009 Quarantine file generators
- Status: todo
- Size: M
- Depends on: FH-002
- Goal: `src/quarantine/` produces minimal, reversible quarantine edits: Jest/Vitest (`test.skip` with a `// flakehound: quarantined until YYYY-MM-DD (#issue)` comment), pytest (`@pytest.mark.skip(reason=...)` or a `quarantine.txt` list), Go (`t.Skip`). Plus an un-quarantine operation.
- Acceptance: tests apply and revert edits on fixture files byte-for-byte.

### FH-010 Report renderer
- Status: todo
- Size: S
- Depends on: FH-007, FH-008
- Goal: `src/report.ts` renders a Markdown summary for PR comments and a weekly report.
- Acceptance: snapshot tests.

## M1 Service (outline, detailed by the weekly planning session)

- FH-011 Upload GitHub Action (`action.yml`) that finds JUnit files and posts them.
- FH-012 Ingest API on forge-core with auth per installation.
- FH-013 Storage schema (Postgres) and in-memory adapter.
- FH-014 Detector job and PR comment.
- FH-015 Explainer with forge-core LLM layer.
- FH-016 Quarantine PR + tracking issue.
