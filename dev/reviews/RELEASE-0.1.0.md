# Alder 0.1.0 release review

This is a historical review of the exact artifacts identified below. Generated
`evidence/` directories are retained locally and ignored by Git; the scripts
and written reports are versioned. The newer [input-latency review](INPUT-LATENCY.md)
records unmet responsiveness targets and unresolved regression findings.

> Follow-up: the [bulk-DE scale review](BULK-DE-SCALE.md) adds the requested
> approximately 1,000-line workload and validates the v19 state-poll performance
> amendment with scoped tests and installed browser evidence. The v17 release
> results below remain the historical exact-artifact review.

**Status: Alder 0.1.0 is accepted for its first complete release.** All four
review cycles, both final cold cycles and all 26 active user flows are complete.
No unresolved Critical or High finding remains. The North Star rubric is the
acceptance authority. The package is built and ready; no publication, push or
remote CI execution is claimed.

## Candidate and validation

[Current package](evidence/release-completion/candidate-v17/alder_0.1.0.tar.gz):
561,915 bytes, SHA-256
`74878eb46a79dd41bbae470662c974270e0a7032a5df54a022c15db36ca4b444`.

[Independent archive review](evidence/release-completion/final-delivery-review/V17-ARCHIVE-CORRESPONDENCE.json)
verifies all 84 regular members and correspondence to source. Relative to v16,
only one MCP test and the generated package timestamp changed. Every product
file, all three reviewed native browser assets, 32 active audit inputs and seven
validation drivers remain unchanged.

| Gate | Evidence and actual result |
| --- | --- |
| Static, lint, editor bundle, build and source identity | [v17 freeze](evidence/release-completion/freeze-v17/): passed, zero lints and clean resources |
| Full source and browser suite | [v16 exact product source](evidence/release-completion/cold-v16-1/02-source-totals.json): 4,110 assertions / 403 tests, zero failures, errors, warnings or skips |
| Complete changed source test file | [Current MCP source](evidence/release-completion/root/mcp-widget-startup/source-after1/totals.json): 830 assertions / 40 tests, zero other outcomes and clean resources |
| First complete v17 cold | [cold-v17-1](evidence/release-completion/cold-v17-1/): passed all gates at 06:46:22 UTC: 4,116 installed assertions, zero failures/warnings/skips, Status OK; 22 audits, 25 direct visuals, 252 inventory files and strict clean resources; all 68 observed ports closed |
| Second complete v17 cold | [cold-v17-2](evidence/release-completion/cold-v17-2/): passed all gates at 07:33:40 UTC after its separate 06:48:01 restart; 4,116 installed assertions, zero failures/warnings/skips, Status OK; 22 audits, 25 direct visuals, 252 inventory files and strict clean resources; all 68 observed ports closed |
| Four review cycles, flows, findings and final scores | [Final independent integration](evidence/release-completion/final-delivery-review/V17-FINAL-INTEGRATED-REVIEW.md): all four cycles and 26 active flows closed; 40 final finding dispositions reconciled, no unresolved Critical/High; all 12 criteria assessed below |

The source results are explicitly separate runs. Independent review accepts this
composition for the single test setup correction; it is not represented as a
new full v17 source run. Both v17 cold checks execute every installed test and
browser test, all 22 installed audits, source/input identity checks and strict
final resource cleanup. Independent direct inspection accepted all 25 fresh
screenshots in each run with their public state and diagnostic channels.
The [root terminal review](evidence/release-completion/root/V17-ROOT-FINAL-VALIDATION.json)
also verifies both complete summaries, all ten driver phases per cycle and the
final idle container. Both full checks report zero errors, warnings and notes.

## Latest correction and retained failures

B153 corrects one test that applied its short widget wait budget to deferred
notebook startup. The test now completes normal startup, checks that it settled
without error, and then applies the same two-second per-wait widget budget.
Both presses explicitly reject a top-level RPC error. Every original widget,
reset and repeated-click assertion remains.

[Controlled before/after evidence](evidence/release-completion/root/mcp-widget-startup/MCP-WIDGET-CAUSAL-REVIEW.md)
reproduces the missing-result parser error with a slow startup and shows the
same notebook passing with corrected setup. Holding one real reset callback
still produces a widget timeout and five original assertion failures; delivering
that callback once restores normal operation and the repeated click succeeds.
All eight comparison oracles and strict cleanup pass. The expected negative
outcomes are preserved. The original cold's raw response was not recorded, so
its specific cause remains unconfirmed; ten unchanged replays passed 200 checks.

All earlier failed cold attempts remain failed evidence. The first v16 attempt
passed the complete source suite, then failed a loopback startup audit whose
helper omitted child diagnostics. The next v16 attempt passed all 22 audits,
252 verified evidence files and 25 directly reviewed images, then failed the
single MCP test above (4,098 passes, one error, no warnings/skips). Both cleaned
up fully. The excluded MCP audit now retains startup observations and fails if
that capture fails; its successful and deliberate early-exit checks are retained.

[Failure attribution](evidence/release-completion/root/RECENT-FAILURE-ATTRIBUTION.md)
separates environment setup, product defects, test/audit defects and unattributed
events. No failed run or unobserved historical cause is used as release approval.
The [finding ledger](review-log.md) holds the detailed repairs and earlier cycles.

## Independent product review

| Scope | Evidence |
| --- | --- |
| Reactive execution, R breadth, complete conditions, values and API safety | [Runtime review](evidence/release-completion/runtime-review/REVIEW.md) |
| Scientific outputs, widgets, app mode and accessibility | [Scientist review](evidence/release-completion/scientist-review/REVIEW.md) |
| Installation, publishing, source/destination safety and environments | [Release review](evidence/release-completion/release-review/REVIEW.md) |
| Current diagnostics and historical action errors | [B135/B140 visual review](evidence/release-completion/scientist-review/B135-B140-VISUAL.md) |
| Native help, navigation, formatting, conflict handling and save/autosave | [Current native review](evidence/release-completion/final-delivery-review/B151-NATIVE-COMMAND-REVIEW.md): 34 checks, 12 actual screenshots and complete input/source/channel receipts |
| All user flows and findings | [Flow matrix](user-flow-matrix.md), [finding ledger](review-log.md), [cycle 4](evidence/release-completion/CYCLE-4-SUMMARY.md) |

## North Star assessment

The [current runtime/API assessment](evidence/release-completion/root/V17-RUNTIME-API-NORTH-STAR-ASSESSMENT.md)
and [final visual/delivery integration](evidence/release-completion/final-delivery-review/V17-FINAL-INTEGRATED-REVIEW.md)
support the following final scores on the rubric's 0–4 scale. Root accepts
**48/48** for the reviewed first-release scope. The assessments bind current
v17 source, both fresh complete runs and the later repairs; older v11
assessments remain historical. These scores concern demonstrated behavior and
the explicit limits below, rather than an exhaustive proof about arbitrary R.

| Criterion | Score | Accepted behavior |
| --- | ---: | --- |
| Reactive correctness | 4 | Dependency order, automatic/lazy execution, invalidation, widget reset, failure and restart recovery |
| R-language breadth | 4 | Ordinary scientific R, functions, formulas, namespaces, pipes and DBI; bounded actionable static restrictions |
| Condition fidelity | 4 | Ordered complete conditions, current-source diagnostics, historical action errors and process failures |
| Scientific outputs | 4 | Directly inspected native and composed plots, tables, models, rich outputs and both publishing engines |
| Interaction integrity | 4 | Native editor/widget actions, repeated buttons, focus retention, keyboard commands and app controls |
| Data and work safety | 4 | Atomic/conflict-aware saves, current-value ownership, interruption, source and destination preservation |
| Reproducibility | 4 | Real renv restore, library isolation, dependency-aware caches, seeds and repeatable rendering |
| R-native ergonomics | 4 | Installed tutorial, one-command launch, completion, signature help, full R help and editing workflows |
| Visual and accessibility quality | 4 | Readable scientific/state presentation, responsive views, keyboard focus and independent semantic controls |
| Security and resource resilience | 4 | Validated local boundaries, bounded inputs, recovery and strict clean process/port lifecycle |
| Agent/API parity | 4 | Shared Session contracts across HTTP and local/URL MCP, including stale-value and readiness boundaries |
| Delivery maturity | 4 | Deterministic bundle, lint/build/check, meaningful regressions, four review cycles and two exact cold passes |

## Scope and limits

Alder provides an R-first reactive local notebook with plain `.R` source,
automatic and lazy execution, R editor assistance, interactive widgets,
scientific outputs and layouts, app mode, atomic conflict-aware saves, renv,
dependency-aware caching, headless execution, publishing/conversion and MCP
clients sharing Session correctness. The installed Iris example uses base R
and Alder. Publishing supports knitr/Quarto and direct Pandoc with explicit
engine provenance.

R code runs with the user's permissions. Static analysis restrictions are bounded
and documented; external effects and reference-object mutations are not
transactional. HTML widgets are isolated. The observed upstream lintr
computed-call failure remains visible and is not represented as repaired.

The package requires R >= 4.6.0. Local validation uses Linux, R 4.6.1 and Chrome
152. R-devel and native Windows CI are configured but have not been executed
here. Cold validation independently restarts the verified development container
and installs Alder into a fresh private library against resolved dependencies.
It does not repeat a bare operating-system bootstrap. Initial dependency
restoration diagnostics remain preserved; both final release gates are
warning-free and leave no leaked resources.
