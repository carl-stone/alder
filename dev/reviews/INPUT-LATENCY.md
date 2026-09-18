# Measuring notebook responsiveness

Use this when an assignment affects performance. The product requirements are in
[ARCHITECTURE.md](../ARCHITECTURE.md); build instructions are in
[dev/README.md](../README.md). Historical benchmark results do not establish the
current app's behavior. The old latency driver and dashboard are retired.

- Measure actual Mac startup, typing, running and cell creation separately.
  Choose representative notebooks, including a dependency chain and unrelated cells.
- Start timing at the real input event and end when the correct result can be
  seen. An internal method return alone does not measure visible responsiveness.
- Compare changes under comparable hardware, power and runtime conditions.
  Separate instrumented profiling from ordinary interactions.
- Retain failures and timeouts instead of dropping them from samples.
- Set performance expectations for the user workflow being improved. Old universal
  median/p95 thresholds are not current acceptance criteria.
- Prefer removing unnecessary work before adding batching, caches or protocols.
  Check affected R semantics, cancellation and output behavior after changes.

Use a small measurement suited to the current question; do not recreate a release
qualification system. Keep generated measurements out of Git.
