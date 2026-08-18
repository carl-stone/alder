# Multi-output cells

Status: Accepted  
Date: 2026-08-17

## Context

Notebook cells can emit streams, media, layouts, and a final visible value. A singular output field cannot preserve emission order or represent nested output.

## Decision

Cell state stores an `outputs` array. Streamed records appear in emission order and the visible value is last. Progress is a separate per-cell record. All output records use a validated wire contract and nested layout children are released recursively.

## Consequences

Rendering and export share one ordered representation. Session, worker, and client code must not reintroduce the old singular `output` field.

This decision is part of the full marimo parity implementation plan.
