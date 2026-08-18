# Streaming worker notifications

Status: Accepted  
Date: 2026-08-17

## Context

Long-running cells need to expose appended output, progress, and logs before evaluation finishes. The existing request/response worker protocol only represented terminal results.

## Decision

The worker emits strict, request-scoped JSON notification frames while an evaluation is pending. Each frame carries the cell id, run id, and a monotonically increasing sequence number. The parent accepts only notifications matching the pending evaluation context.

## Consequences

The UI can render partial work without weakening transport validation. Cancellation and late frames require explicit dropping rules, and every new stream payload needs bounded validation.

This decision is part of the full marimo parity implementation plan.
