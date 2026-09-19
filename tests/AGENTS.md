# R tests

These instructions apply to `tests/` and its descendants. Host, browser and
desktop tests have their own guidance in [host/test/AGENTS.md](../host/test/AGENTS.md).

## What a test must establish

- Test an R semantic or user-visible notebook behavior with an independently
  derived expected result. For ordinary R behavior, prefer a small plain-R
  example whose answer is obvious without calling the implementation twice.
- A failing new test may be the first useful evidence of a production bug. Check
  the implementation against the stated R semantics or product behavior before
  changing the expectation. Do not infer correctness from the old suite passing.
- Give each test one readable reason to fail. Its name and assertions should
  explain the protected behavior to an engineer who has not read the production
  code. Use arrange, act and assert structure without ceremony.
- Keep a regression test when it protects a requirement, a plausible expensive
  failure, or a defect that actually occurred. Coverage counts, function counts
  and the amount of code already written do not justify a test.
- Use the lowest boundary that proves the behavior. Add an integration journey
  only when a unit-level test cannot establish that the real components work
  together. Do not repeat every lower-level branch at the higher level.

## Avoid implementation locks

- Do not assert private helper calls, internal object shapes, exact diagnostic
  wording, incidental field names, source layout or intermediate event order
  unless that detail is an intentional external contract.
- Do not generate expected analyzer or dependency results with the same analyzer
  or algorithm under test. State the expected graph, rerun set or output directly.
- Use fakes or mocks to induce a narrow failure or control a boundary. They do
  not establish that Ark, R, package installation or the installed application
  works. Keep at least one real, local journey for each critical integration.
- When a design is replaced, delete tests that only preserve the old mechanism.
  Rewrite a test only when the underlying user guarantee still exists. Never
  change an expectation merely to conceal a defect.
- Test count and file structure are not assets. Delete an entire test file when
  most of it freezes a retired representation or duplicates stronger behavior
  coverage; replace it with only the small independent examples still needed.

## R-specific expectations

- Preserve representative scope, dependency, barrier, dynamic-mutation, cache,
  output and widget semantics. Prefer table-driven cases over repeated tests of
  the same parser representation.
- Automatic inspection must not force promises, invoke user methods or mutate
  the workspace. Test observable effects and subsequent execution rather than
  private inspection payload fields.
- Keep public notebook helpers independent of application transport state. R
  package tests cover explicit `ui`/`out`/`cache` value semantics; analyzer and
  private Ark-adapter behavior belongs to their service/integration boundary.
- Keep fixtures hermetic and network-free. Use temporary project libraries and
  local package fixtures; prove the selected library changed and an unrelated
  user or global library did not.
- Keep timing and profiling outside correctness tests. Measure performance on
  known Mac hardware with representative notebook interactions after behavior
  works; do not encode aspirational latency thresholds as portable correctness.

Run the focused file while developing, then the relevant R suite. Report skipped
integrations as missing evidence rather than a pass. Only the lead accepts a
checkpoint.
