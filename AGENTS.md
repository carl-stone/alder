# Working on Alder

Alder is a reactive notebook for R. The next implementation target is
[dev/ARCHITECTURE.md](dev/ARCHITECTURE.md); development commands are in
[dev/README.md](dev/README.md).

- Edit files and use Git on the host. Run install, build, test, lint and app
  commands in `codex-universal`, with this checkout mounted at `/workspace/alder`:
  `sudo docker exec -i -w /workspace/alder codex-universal bash -lc '<command>'`.
- Edit widget constructors in `R/ui-widgets.R`. Ark loads the installed
  package implementation; there is no worker mirror.
- After editing `js/src/editor.ts`, rebuild the committed CodeMirror bundle
  with `npm run build --prefix js` inside the container.
- Preserve generated R help and exports; their source is the roxygen comments
  in `R/`. Keep notebook examples runnable as ordinary R scripts.
- Prefer code and regression tests to prose. Comments should explain
  non-obvious behavioral decisions. Update existing docs when behavior changes;
  do not accumulate task ledgers, review transcripts or duplicate specs.
- Keep generated review evidence and Python caches out of Git.

## Agent routing

Prefer appropriate delegation, not maximum delegation.

- Use `task` (Luna) for bounded implementation, regression tests and focused
  investigation.
- Use `reviewer` (Opus) for independent reviews of consequential cross-cutting
  correctness: shared contracts, ownership boundaries and integrated changes.
- Use `security-reviewer` (Opus) when authentication, capabilities, sandboxing
  or trust boundaries change.
- Select these agent types explicitly. Relabeling a generic `task` assignment
  as a review does not select the stronger reviewer role.
- Attach stronger reviews to coherent integration candidates, not every small
  edit or worker handoff. Reuse valid reviews for unchanged identified scope.
- If a worker repeatedly misses acceptance criteria or a focused correction
  fails, reassess the assignment and escalate rather than sending it back
  unchanged.
- Main owns decomposition, shared decisions, integration and checking evidence.
  Worker completion claims and reviewer approval do not replace verification.
- Delegate only cohesive work with explicit scope, ownership and required
  evidence; keep one writer per shared file or boundary. Handle trivial work
  directly.
- Apply the project-specific review gates in
  [ALDER_ARCHITECTURE_PLAN.md](ALDER_ARCHITECTURE_PLAN.md#required-independent-review-gates)
  at the named contract freezes and integration exits.
