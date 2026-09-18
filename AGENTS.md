# Working on Alder

Alder is a reactive notebook for R. Carl defines the desired experience and R
semantics; agents own the engineering. Surface verification, uncertainty and
process details only when they affect the result, need a decision, or block work.

## Task roles and continuity

- The lead task is `01a0b55f-feaf-7c03-9964-b448891e33d5`. At the beginning of
  its work turns and after compaction or resumption, read [dev/LEAD.md](dev/LEAD.md)
  before taking action. Use the task ID, not its title, to identify this role.
- The lead interprets wishes, makes engineering decisions, delegates, reads
  code and results, and accepts completed work. It may always edit documentation.
  It may edit other files only when Carl directly asks it to do so; that exception
  applies to the requested work and does not permanently change the role.
  Builds, application runs, tests and other implementation work belong in the
  implementation task unless Carl directly assigns them to the lead.
- Lead-only restrictions do not apply to implementation or review tasks.
  Inheriting this conversation does not make a worker the lead.
- One primary implementation task owns the integrated app. It may delegate
  bounded work with explicit ownership and acceptance criteria. Keep one writer
  per shared boundary; use separate worktrees for independent writers.
- Carl can change the lead mandate. Workers cannot change roles, expand their
  own authority, or approve their own completion. Send technical questions and
  proposed changes to shared decisions to the lead.
- [dev/LEAD.md](dev/LEAD.md) is the single current coordination record. The lead
  updates it in place when decisions, assignments or acceptance change. Preserve
  the distinction between discussion, decision, assignment and acceptance.
  Check live task status when it matters; old summaries are not current status.

## Product and design authority

- [dev/ARCHITECTURE.md](dev/ARCHITECTURE.md) records the reset's product requirements
  and working design. [dev/README.md](dev/README.md) describes development commands.
- Ark must remain unmodified upstream: no fork, source/binary patches or runtime
  replacement of its internals. Keep Alder-specific behavior in Alder-owned
  adapters and R helpers. This is Carl's constraint, not a tradeoff agents may
  override; the existing patch must be removed during the execution reset.
- Mac is the only active platform. Delete Linux/Windows implementations,
  packaging and platform-only checks now; qualify those platforms separately
  later. Keep as much real application behavior OS-independent as reasonably
  possible, with small Mac adapters and no speculative portability framework.
- This is pre-release software. Whole-component rewrites and deletion are
  authorized. Choose languages for the component's behavior and demonstrated
  performance needs; Rust is not a requirement or proof of speed. Migration
  complexity, sunk cost and estimated effort must not preserve a worse design.
- Carl approved removing bespoke dependency certification, the oversized
  command/recovery framework, handwritten JSON parsing and repeated validation,
  five-layer settings precedence, and excess R-adapter machinery. Replace these
  with the small designs in dev/ARCHITECTURE.md; do not preserve them as wrappers,
  compatibility paths or test requirements.
- The old architecture plan, review matrix and latency migration freeze are
  superseded. Git history, existing tests and implementation choices are evidence
  of past behavior, not automatic requirements for the reset.
- Preserve useful behavior through concrete notebook examples. Resolve expected
  results independently of the implementation. Change tests when an accepted
  product decision changes; never hide a defect by changing an expectation.
- Prefer platform facilities and existing libraries to new mechanisms. Every
  added service, protocol, validation layer or dependency must earn its cost
  through observable behavior. Remove replaced production paths as slices land.

## Implementation and review

- Implement complete, runnable slices. Review consequential integrated changes
  with fresh context, including their complexity and failure behavior.
- Choose available agent capabilities deliberately. No specific model label or
  reviewer approval is a substitute for checking the actual app.
- Retain renderer isolation, authenticated local APIs, external-edit conflict
  handling and ordinary child-process cleanup. The notebook executes trusted R
  with the user's permissions; do not invent hostile-R containment requirements.
- Run native Mac builds and interaction checks on macOS. Delete obsolete CI,
  release matrices, duplicate checks and tests pinning retired implementations.
  Keep a small set of useful build, behavior and native interaction checks;
  expand only for concrete failures. Do not recreate the former gate system.
- Widget constructors live in `R/ui-widgets.R`; Ark uses the installed package.
  Rebuild committed bundles after changing their sources: `npm run build --prefix
  js` for the editor, `npm run build --prefix host` for host/browser code.
  Generated R help and exports come from roxygen comments in `R/`.
- Keep examples runnable as ordinary R scripts. Preserve unrelated work and keep
  generated evidence and caches out of Git. Update the existing docs instead of
  accumulating task ledgers or review transcripts.
