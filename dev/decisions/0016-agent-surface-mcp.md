# Agent surface: MCP

Status: Accepted  
Date: 2026-08-17

## Context

Notebook agents need a structured interface for reading, editing, running, checking, exporting, and inspecting data without depending on browser internals.

## Decision

Alder exposes an MCP JSON-RPC 2.0 server over line-delimited stdin/stdout, with an in-process session backend or a REST proxy backend. Tools return compact JSON and resources expose source, DAG, and cell outputs.

## Consequences

Agent clients get one stable protocol surface. Every mutation must use existing notebook/session validation and errors must preserve alder error codes in MCP responses.

This decision is part of the full marimo parity implementation plan.
