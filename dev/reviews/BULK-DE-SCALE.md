# Representative bulk differential-expression notebook

The representative long notebook passes scientific and installed-browser
acceptance. This supplements the earlier v17 release review with the user's
requested approximately 1,000-line workload.

Generated `evidence/` directories are retained locally and ignored by Git;
the paths below identify those local records. The notebook, audit scripts and
this report are versioned.

## Workload

[Notebook](../examples/bulk-differential-expression.R): 1,262 physical lines,
1,016 nonblank/noncomment R lines, 65 cells (56 code and 9 Markdown).
The static dependency graph has 190 edges. The analysis is present in the notebook itself. It simulates 6,000 genes in
24 independent samples, balanced across two conditions and three batches.
The counts matrix contains 144,000 integer observations.

The workflow includes input/design validation, library and expression QC,
expression filtering, TMM normalization, PCA, sample correlation and clustering,
batch-adjusted edgeR quasi-likelihood fitting/testing, BH adjustment, interactive
FDR/effect cutoffs, volcano/MA/heatmap/gene plots, a separate minimum-effect
`glmTreat` analysis, sensitivity summaries, and reproducibility deliverables.
The [edgeR guide](https://bioconductor.org/packages/release/bioc/vignettes/edgeR/inst/doc/edgeRUsersGuide.pdf)
is the methodological reference. This is a synthetic software-validation
example, not a biological result or a repeated-simulation calibration study.

In Alder source execution, all 5,016 rows of both result tables and the model
coefficients agree with ordinary R execution to tolerance 1e-10. At the default display cutoffs, 501
genes are selected; the FDR-only test identifies 503. Among the 499 planted
nonzero effects retained by expression filtering, 475 are recovered (95.19%);
28 null genes are called, a realized false-discovery proportion of 5.57% in
this one simulation. All retained effect directions agree with the planted
truth. These metrics are computed after fitting; truth is not used to fit the
model. The strict display cutoff of absolute log2 fold change 2 selects 33 genes.

## Installed browser acceptance

[Run 07](evidence/bulk-de-scale/run-07/result.json) passed all 32 audit checks
against the matching v19 artifact. Both executions ended with all 65 cells done.
All 18 plot images loaded, and the retained final cell logs, browser console,
exceptions, browser log, loading-failure and dialog channels are empty.

| Operation | Observed time |
| --- | ---: |
| Ordinary R analysis | 9.19 s |
| Alder source execution | 6.99 s |
| CLI readiness | 10.77 s |
| Open 65-cell browser notebook | 2.47 s |
| First complete browser execution | 58.24 s |
| Effect cutoff update, 501 → 33 selected genes | 18.20 s |
| Save edit near end of notebook | 5.03 s |
| Additional wait for browser save acknowledgment | 1.74 s |
| Reload | 2.63 s |
| Second complete browser execution | 60.36 s |
| Native shutdown | 1.71 s |

Three state requests took 1.259, 1.445 and 0.743 seconds while browser polling
was also active. These are end-to-end audit observations on this droplet,
including rendering and simultaneous probe/browser polling, not a throughput
benchmark or a claim of instantaneous interaction. The threshold update remains
noticeable at this scale even though it does not refit the model.

The strict cutoff changed selection and plots but preserved the model output,
including its fit-completion timestamp. The model is outside the threshold's
DAG descendants and was not observed running during the update. Native typing
and Ctrl-S saved an edit in cell 65; all records of the other 64 cells remained
identical, the original fixture stayed unchanged, and reload retained the edit
without an unsaved-changes dialog. The second full run produced the same
scientific summary and a new fit-completion marker.

Visual review checked the QC, PCA, default/strict volcano and top-gene heatmap
plots and the final/reloaded summary. See the [QC](evidence/bulk-de-scale/run-07/01-qc.png),
[volcano](evidence/bulk-de-scale/run-07/03-volcano-default.png),
[heatmap](evidence/bulk-de-scale/run-07/04-heatmap-plot.png), and
[reloaded summary](evidence/bulk-de-scale/run-07/07-reloaded-summary.png).
Labels, legends and values reconcile with the analysis; the final saved comment
is visible near the end of the source.

The CLI exited zero with empty stderr and no forced termination. The independent
[resource audit](evidence/bulk-de-scale/run-07/98-process-final.json) found no
remaining workloads, zombies or review listeners. Input hashes still matched
at completion. The container is idle.

## Product finding and fix

The first installed browser run timed out after 180 seconds. Profiling found
unchanged source-reference ranges being rescanned on every state poll (1.27
seconds in an isolated profile). Caching the structured ranges improved that
part, but a second browser run still timed out. Native-state profiling then
measured 3.30 seconds serializing the two compatibility copies of those ranges.

Session now caches ranges by ordered cell IDs, bodies, definitions and references.
HTTP state responses reuse the encoder-produced JSON for both copies. Source
edits, ownership changes and structural changes invalidate both forms; runtime
values, status, diagnostics and graph projections remain current. Ordinary R
state remains structured. Transport tests compare the entire decoded response
with ordinary encoding, including text containing quotes, Unicode and braces.
Projection failures use the ordinary encoding path.

The final development profile measured repeated complete encoded-state generation
at 0.467, 0.484 and 0.459 seconds after warm-up. Actual browser request and execution
timings are recorded separately by the installed audit.

## Evidence and scope

- [Range-cache tests](evidence/bulk-de-scale/targeted-tests.log): 523 dataflow/Session
  assertions, zero failures/warnings/skips (v18 range-cache implementation).
- [Final transport tests](evidence/bulk-de-scale/transport-tests-02/tests.log): 421
  dataflow/HTTP assertions, zero failures/warnings/skips; strict clean teardown.
- [Final profile/lint](evidence/bulk-de-scale/transport-tests-02/profile-lint.log):
  both changed R source files have zero lints.
- [Rescan mutation](evidence/bulk-de-scale/mutation-rescan.log) and
  [stale JSON mutation](evidence/bulk-de-scale/mutation-stale-json.log): the new
  regression fails for both deliberately reintroduced defects. Mutations existed
  only in isolated R processes; repository source was not mutated.
- Final artifact: `evidence/bulk-de-scale/candidate-v19/alder_0.1.0.tar.gz`, SHA-256
  `af0884dc47cb7d25a1f585e8f8fe27fdce5149b998dc551dea4203996a3a9478`.
- Notebook SHA-256:
  `cd17d9a3d0375a92bb1ebdc6a0956810a054e76f8931cd83d3e7e0ad10963003`.

The earlier v17 full release/cold-check results remain historical evidence for
that artifact. This follow-up performs scoped regression and installed workload
validation; it does not represent another unfiltered full release cycle.
The workload establishes approximately 1,000 lines of source, not 1,000 cells,
and is not evidence for hundreds of thousands of lines or much larger datasets.

## Failed attempts retained

- Runs 01–02: static warnings in the new fixture's bare plotting-column references;
  resolved with explicit `.data` references. No execution occurred.
- Run 03: original product state-poll performance timeout. The new probe also
  mishandled reading a closed process pipe during failure cleanup; its transcript
  and independent clean resource audit remain available.
- Run 04: environment preflight rejected one orphaned zombie before Alder launch.
  The precise originating subprocess was not established. The idle container
  was restarted before the next attempt.
- Run 05: the structured-range cache alone did not resolve the product timeout;
  subsequent profiling identified repeated JSON encoding. Clean teardown passed.
- Run 06: full execution (58.18 seconds), 18 plots, scientific parity, threshold
  propagation without refitting and source-preserving save passed. Reload
  automation timed out without a browser exception; the probe had only waited
  for the disk write. Replay adds browser save acknowledgment, navigation-event
  waiting and dialog capture. The exact cause of the earlier reload timeout
  was not captured and is not retrospectively claimed as proven. Cleanup passed.
  Run 07 completes the entire workflow on the same package and notebook with
  those harness corrections; all dialog/error channels remain empty.
- First transport-only test attempt: the new test command omitted the installed
  package library required by subprocess workers. Corrected setup installs the
  matching artifact and supplies its library; repeated assertions were symptoms
  of that single setup error. Its resource audit passed.
- The mutation runner's initial selector/deparse setup errors are retained beside
  the successful mutation evidence; they are not Alder regressions.

## Reproduce

Install Alder and the optional scientific dependencies (`edgeR`, `statmod`,
`ggplot2`; edgeR installs limma). Use `BiocManager::install("edgeR")` for edgeR,
then launch `alder dev/examples/bulk-differential-expression.R` from the repository.
These optional dependencies do not become Alder imports.

The audit additionally needs Chrome, chromote, curl and digest. In this workspace,
run inside `codex-universal`, under one long-lived subreaper, with a new empty
evidence directory and a source archive matching the current package:

```sh
docker exec -i -w /workspace/alder codex-universal bash -lc \
  'tini -s -- bash dev/reviews/run-bulk-de-scale.sh /tmp/bulk-de-evidence dev/reviews/evidence/bulk-de-scale/candidate-v19/alder_0.1.0.tar.gz'
```

The driver verifies the archive/source relationship, installs privately, compares
ordinary R with Alder, drives the actual browser, records outputs/timings and
checks for remaining workloads, zombies and listeners after shutdown.
