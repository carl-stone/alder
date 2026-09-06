# 0018 — Reproducible environments: standard renv lockfiles and libraries

Status: Accepted

Date: 2026-09-02

## Context

Package-name declarations and a directory merely named after renv do not make
an analysis reproducible. Scientists and R tooling already understand
project-level `renv.lock` files and renv's platform/R-version library layout.
Inventing a parallel lock format would violate the North Star.

## Decision

- Keep lightweight package declarations in `.alder/packages.yaml` for the live
  package panel and asynchronous installation.
- Use `alder_env("snapshot"|"status"|"restore")` for reproducibility. It writes
  and reads the standard project `renv.lock`, records recursive dependencies,
  reports R/package drift, and restores into `renv::paths$library(project)`.
- Ordinary workers prepend `.alder/library`, the live install target, so a
  successful install becomes available after worker restart.
- `sandbox = TRUE` uses the standard renv project library. The worker loads
  Alder and its runtime dependencies first, then restricts notebook package
  lookup to the renv library plus R's base/recommended library. It never claims
  to sandbox trusted R code from the filesystem, process, or network.

## Consequences

Alder projects interoperate with existing renv tooling and lockfile review.
Restoration may require repository/network access and compiled system
dependencies; failures remain visible. Dependency isolation is stronger and
testable, while security isolation remains explicitly out of scope.
