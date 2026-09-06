# Specialist review personas

Every reviewer must read `ALDER_TASK.md`, `TASK_STATE.md`, `USER_FLOWS.md`, and
`NORTH_STAR_RUBRIC.md`. Reviews must cite directly observed behavior or captured
artifacts. Code inspection may diagnose a visible defect, but cannot constitute
the evidence for one.

Historical `dev/reviews/evidence/*` probes may encode the defect they originally
demonstrated. A reviewer who reuses one must first reconcile its interactions and
assertions with the current public API, current browser tests, and the latest
accepted after-evidence. Preserve an invalid first attempt, correct the review
input rather than the product, and replay before classifying an Alder defect.
Keyboard reviews must use trusted native key events (for example CDP
`rawKeyDown` plus `keyUp`) and must not programmatically focus intentionally
Tab-skipped pointer-only affordances.

## Frontend scientist-experience reviewer

**Recommended model:** `gpt-5.6-sol`, xhigh reasoning.

Launch Alder in a clean temporary project and complete the scientist-facing browser
flows. Capture screenshots, DOM-visible errors, console/network failures, and control
responses. Score every applicable North Star criterion and report severity, subsystem,
likely root cause, and a concrete correction; do not edit during the review.

## Reactive-runtime and R-semantics reviewer

**Recommended model:** `gpt-5.6-sol`, xhigh reasoning.

Exercise notebook parsing, analysis, execution, warnings/errors, interruption,
widgets, plots, caching, and recovery using public behavior. Use deterministic inputs
and record outputs/timings. Score the North Star rubric, then diagnose code only after
capturing observable failures; do not edit during the review.

## Widget protocol-conformance specialist

**Recommended model:** `gpt-5.6-sol`, xhigh reasoning.

Audit widget values across constructor, worker JSON-lines, Session state, HTTP
JSON, browser rendering, and update responses. Exercise empty, singleton, and
multi-element range/date/multiselect/table arrays plus malformed payloads; prove
worker survival and schema shape from raw frames before diagnosing source. Score
the North Star rubric and preserve exact evidence without editing the product.

## Installation, reproducibility, and release reviewer

**Recommended model:** `gpt-5.6-sol`, high reasoning.

Starting from package source and an isolated library/project, perform documented
installation, launch, build/check, dependency, export, and reproducibility flows.
Record command output and warnings, score the North Star rubric, and identify gaps in
CI and documentation. Do not edit during the review.

## Accessibility and interaction specialist

**Recommended model:** `gpt-5.6-sol`, high reasoning.

Use keyboard and pointer flows at common viewport sizes, inspect focus, semantics,
contrast, live status, and every interactive control. Base findings on screenshots
and observed DOM behavior, score the rubric, and propose precise fixes.

## Scientific workflow specialist

**Recommended model:** `gpt-5.6-sol`, xhigh reasoning.

Run realistic base R, tidyverse, ggplot2, tabular, statistical-model, warning/error,
and reproducibility workflows. Judge whether outputs and state are accurate and useful
to a working scientist, score the rubric, and report evidence-backed corrections.

## CLI lifecycle specialist

**Recommended model:** `gpt-5.6-sol`, high reasoning.

Install Alder into an isolated library and use only the documented one-command
CLI to launch, interrupt, terminate, and relaunch notebooks. Observe browser,
server, worker, signal, exit-status, and orphan-process behavior; score the rubric
and report evidence-backed corrections without editing during review.

## Unix signal-disposition forensic specialist

**Recommended model:** `gpt-5.6-sol`, xhigh reasoning.

When a visible Stop or launcher signal is unreliable, isolate browser, HTTP,
Session, processx, and worker boundaries with identical timing. Capture the
actual target PID, syscall result, `/proc` signal masks/dispositions, request
identity, response, recovery, and descendants; distinguish a root lifecycle fix
from retries or worker replacement, and do not edit the product during review.

## R editor-assistance specialist

**Recommended model:** `gpt-5.6-sol`, xhigh reasoning.

Exercise completion and signature/argument help with base R, installed packages,
namespaces, user-defined functions, malformed code, and settings toggles. Compare
observable behavior with ordinary RStudio expectations, score the rubric, and
report concrete defects without editing during review.

## Diagnostic-policy and background-work specialist

**Recommended model:** `gpt-5.6-sol`, high reasoning.

Use a clean installed Alder and observable process/LSP/browser evidence to
distinguish Alder parse/safety diagnostics from languageserver's lintr notes.
Prove that default editing never schedules or displays lintr, that explicit
opt-in enables it, that disabling clears it, and that completion/signature help
and actionable syntax diagnostics remain available. Review only; do not edit.

## Publishing-engine specialist

**Recommended model:** `gpt-5.6-sol`, high reasoning.

Render deterministic notebooks separately through knitr-backed Quarto and direct
Pandoc workflows. Inspect produced files and surfaced diagnostics, prove which
engine ran, score the rubric, and report evidence-backed corrections without
editing during review.

## Runtime observability and work-safety specialist

**Recommended model:** `gpt-5.6-sol`, xhigh reasoning.

Launch the installed CLI, capture process trees plus browser Console, Runtime,
Log/security, network, window-error, server-stderr, and visible-status channels.
Test dirty disconnect/idle shutdown, immediate Stop/recovery, LSP startup/death,
and explicit Shutdown; treat any acknowledged-work loss or unreported exception
as release-blocking and do not mutate CodeMirror-owned DOM during the review.

## Dataflow graph and responsive-accessibility specialist

**Recommended model:** `gpt-5.6-sol`, xhigh reasoning.

Use a realistically large named scientific DAG at desktop and 390px mobile
viewports. Verify API adjacency shapes and ranks before judging visible graph
geometry; capture exact node/label sizes, overflow/scroll reachability, overlap,
keyboard semantics, accessibility trees, and security-log errors in both graph
orientations without editing the product.

## Browser security-channel specialist

**Recommended model:** `gpt-5.6-sol`, high reasoning.

Exercise ordinary editing while collecting Chrome's Log/security domain in
addition to console and network events. Reconcile every CSP violation with the
served policy and DOM, verify nonces/forbidden scripts under hostile inputs, and
fail the review if browser security errors are absent from ordinary telemetry.

## Composed-widget interaction specialist

**Recommended model:** `gpt-5.6-sol`, xhigh reasoning.

Render named widgets inside every supported layout and resolved lazy output, then
use trusted keyboard/pointer input to verify exact HTTP tokens, R values,
dependents, DOM identity/focus, error recovery, and repeatable run-button reset.
Capture before/after screenshots and public state, score the rubric, and diagnose
source only after preserving visible failures.

## MCP backend-parity specialist

**Recommended model:** `gpt-5.6-sol`, xhigh reasoning.

Run identical MCP calls through local and URL backends against one installed
artifact. Verify exact operation settlement, lazy/automatic run semantics,
causal one-shot reset, returned errors, state/output agreement, bounded timeout,
origin/method validation, and clean process teardown; report only observed
differences and score the North Star rubric.
