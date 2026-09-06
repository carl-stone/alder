# Explicit Quarto/knitr and direct-Pandoc publishing

Status: Accepted (2026-09-02). This refines ADR 0015 and implements the
publishing requirement in ADR 0019. It remains subordinate to the North Star.

## Context

A qmd interchange file is not evidence that either Quarto or Pandoc rendered a
notebook. R users need a conventional computational-document route, while a
static route must preserve Alder's reactive outputs without executing code a
second time. Hiding the distinction makes failures and reproducibility claims
impossible to diagnose.

## Decision

- `alder_render(engine = "quarto")` generates qmd with `engine: knitr`, visible
  warnings/messages, fatal errors, and invokes `quarto render --execute` with
  the active R executable. Native chunks execute in Alder's dependency order;
  a native chunk-hook wrapper retains their rendered output for presentation
  in authored notebook order.
- `alder_render(engine = "pandoc")` executes the notebook once through Alder,
  serializes visible conditions and outputs to Markdown, then invokes Pandoc
  directly. Pandoc never evaluates R.
- Both paths reject direct, canonical, symlink, and hard-link output aliases
  before reading or executing notebook code. Blocking syntax,
  duplicate-definition, dependency-cycle, and dynamic-analysis diagnostics are
  surfaced before user code or an external renderer runs.
- Both paths surface the complete external-process transcript on success or
  failure, produce standalone embedded-resource HTML, stamp engine provenance,
  write to a temporary file, and atomically move only a complete result.
- Both paths exclude disabled cells and their transitive descendants from
  execution while retaining visible source when code is requested.
- Console output, conditions, and appended results retain execution order;
  nested scientific values keep native rendering and HTML widget dependencies.
- The existing qmd export remains an editable interchange format rather than a
  rendering claim.

## Consequences

The 2026-09-05 release review superseded the earlier document-order Quarto
restriction: a valid reactive notebook must publish without moving its cells.
Both engines now preserve the dependency DAG and authored presentation order,
with one execution per enabled cell. Quarto and Pandoc are release/CI dependencies for their
respective engine gates, and missing tools are actionable errors rather than
skipped or silently substituted behavior.
