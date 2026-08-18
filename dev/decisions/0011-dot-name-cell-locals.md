# Dot-name cell locals

Status: Accepted  
Date: 2026-08-17

## Context

Temporary dot-prefixed bindings are common in R code but should not create notebook-wide dependencies or duplicate-definition conflicts.

## Decision

A dot-prefixed name defined by a cell is local to that cell. The analyzer reports it separately from global definitions and the worker mangles the binding inside that cell before evaluation. Dot names not defined by the cell remain ordinary references.

## Consequences

Notebook cells can use independent temporary names safely. Worker evaluation needs symbol-aware rewriting, and reserved runtime names must remain protected.

This decision is part of the full marimo parity implementation plan.
