# Working on Alder

Alder is a reactive notebook for R. Carl defines the desired experience and R
semantics; agents own the engineering. Surface verification, uncertainty and
process details only when they affect the result, need a decision, or block work.

## Start here

Work is coordinated across separate Codex conversations, called tasks. One
**lead task** turns Carl's requests into assignments and reviews completed work.
**Implementation tasks** change and test the app; **review tasks** inspect it.

- **Default: implementation or review.** Follow the request assigned to your
  current task and read the relevant [product requirements and working design](dev/ARCHITECTURE.md).
  You may implement or review as assigned; the lead's restriction on coding does
  not apply to you. The old plan, review matrix and latency freeze are superseded.
- **Special case: the designated lead.** If your current task ID is
  `01a0b55f-feaf-7c03-9964-b448891e33d5`, read [dev/LEAD.md](dev/LEAD.md)
  before acting and after compaction or resumption. Only Carl can designate a
  different lead. Seeing that ID or inheriting the lead's conversation does not
  make your task the lead.
- **Current work and task locations:** [dev/WORKBOARD.md](dev/WORKBOARD.md).
  Only Carl and the lead edit the canonical board; workers report results or
  proposed changes. Queued work and doc changes do not expand an active assignment.
  Use the implementation worktree or the worktree assigned in your brief for code;
  the lead's documentation checkout still contains older source.
- **Builds, checks and generated files:** [dev/README.md](dev/README.md).
  Consult it before building or changing generated assets.
- **Tests:** follow the nearest test instructions. Host and browser tests use
  [host/test/AGENTS.md](host/test/AGENTS.md); R helper tests use
  [tests/AGENTS.md](tests/AGENTS.md). These files define what evidence a test
  must provide and which implementation-coupled tests should be removed.

## Working together

- One primary implementation task owns the integrated app. It may delegate
  bounded work with explicit ownership and acceptance criteria. Keep one writer
  per shared boundary; use separate worktrees for independent writers.
- Workers cannot change roles, expand their authority or approve their own
  completion. Send shared-design questions and completion reports to the lead.
- Preserve unrelated work. Keep generated evidence and caches out of Git.
  Update the existing docs instead of accumulating ledgers or review transcripts.

## Engineering defaults

- Mac is the active platform and Ark stays unmodified upstream. Follow the
  scope, replacement decisions and runtime boundaries in dev/ARCHITECTURE.md.
- This is pre-release software: rewrites and deletion are authorized within the
  assignment. Choose languages for fit and demonstrated performance. Prefer
  platform facilities and libraries; added mechanisms must earn their cost.
- When complexity comes from the wrong ownership model or boundary, delete the
  component and replace it with the smallest correct design. Do not spend time
  preserving its private APIs, tests, migrations or internal compatibility.
  Salvage only independently useful behavior or code that clearly fits the new
  boundary.
- Deliver complete, runnable slices and remove replaced production paths. Use
  concrete notebook examples and independently established expected behavior.
  Existing code and tests are evidence of past behavior, not requirements.
- Keep checks proportionate and tied to behavior. A test must protect a useful
  contract or failure mode, and refactoring behind that boundary should not
  require rewriting its assertion. There is no requirement to preserve test
  count, test files or suite structure: delete whole obsolete suites and replace
  them with a smaller behavioral suite when that is clearer. Run native Mac
  builds and interaction checks on macOS. Review consequential integrated changes
  with fresh context; do not recreate obsolete CI or qualification frameworks.
- Retain renderer isolation, authenticated local APIs, external-edit conflict
  handling and ordinary child cleanup. R runs with the user's permissions;
  do not invent hostile-R containment requirements.
- Keep example notebooks runnable as ordinary R scripts. Never conceal a defect
  by changing a test's expected result. When an independently derived behavior
  test should pass but does not, treat that as evidence of a production defect
  until investigation shows the expectation is wrong; an old green suite is not
  evidence that the implementation works.
