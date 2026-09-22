# Host, browser and desktop tests

These instructions apply to tests in `host/test/`. Product requirements live in
[dev/ARCHITECTURE.md](../../dev/ARCHITECTURE.md); build and staging commands live
in [dev/README.md](../../dev/README.md).

## Write tests that survive a good rewrite

- Start from the behavior or failure risk, then choose the smallest boundary
  that proves it. A useful test fails when Alder breaks a protected contract and
  keeps passing when the implementation behind that boundary is replaced.
- Name the trigger and outcome: for example, `formatter failure still saves the
  current draft`. Keep setup, action and assertions easy to distinguish. Prefer
  a few meaningful state assertions to snapshots of an entire object.
- Derive expected bytes, outputs, graph edges and revisions independently. Do
  not compare one production path with another path using the same algorithm.
- If a new behavior test with an independently justified expectation fails,
  investigate the production path first. Fix the implementation when it violates
  the requirement. Do not weaken the assertion, copy the current output into the
  expectation or assume the behavior works because the previous suite passed.
- Each higher-level test must prove a seam or user journey that lower-level tests
  cannot. Cover branch permutations low in the stack; cover one representative
  journey through the real installed boundary. Delete duplicate tests that add
  runtime without additional confidence.

## Do not pin machinery

- Do not assert private fields or methods, internal call order, exact restart or
  render counts, DOM object identity, process IDs, lock/registry filenames,
  nonces, worker bootstrap layout, incidental error prose or a dependency's exact
  version unless it is a published protocol or file-format contract.
- Do not add production hooks whose only purpose is to expose an implementation
  step to a test. Drive the public controller, client, protocol, browser or native
  application boundary. A narrow parser may be tested directly when its accepted
  input and output are themselves the contract.
- Use a mock or fake to make an owned boundary deterministic, inject a failure or
  prove orchestration. A mock result cannot be the sole evidence for a critical
  integration such as Ark execution, package installation, publishing, shared
  ownership or native document handling.
- Existing tests are evidence of past behavior, not requirements. If a product
  decision or mechanism was removed, delete tests that only preserve it. If the
  user guarantee remains, rewrite the test around the guarantee.
- Test count, line count, filenames and suite structure have no preservation
  value. When a file is dominated by obsolete machinery, duplicated matrices or
  private-state assertions, delete it outright and write the few behavior tests
  the current product needs. Do not migrate every old case into a new framework.

## Make failures informative and reliable

- Assert the durable outcome and the important negative outcome: saved bytes and
  the retained draft, project-library installation and unchanged user library,
  current published HTML and absence of publication after a cancelled save.
- Choose fixture values that distinguish the intended result from a fallback or
  stale state. A dirty flag does not prove recovery if missing state defaults to
  dirty; an old reply carrying unchanged identity does not exercise an overwrite
  race. Check that the assertion would fail for the actual defective outcome.
  Replay the pre-fix path when that is uncertain, rather than adding more assertions
  around a trigger that never reaches the defect.
- Use explicit events, eventual conditions or controllable promises for
  concurrency. Avoid fixed sleeps. A timeout should bound a test, not coordinate
  it. Ensure temporary processes, servers, files and listeners are cleaned up.
- For a changed asynchronous seam, deliberately pause or fail at the existing
  I/O boundary before and after its irreversible effect. Check disk contents,
  visible document identity, retained edits or child exit as appropriate. A
  repeated green run is not a substitute for reproducing the failing ordering.
  Keep the few distinct outcomes; do not build a general scheduler or fault
  framework. When replacing a flawed protocol, replace tests of that protocol
  with tests of the user guarantee.
- Every wait must settle or stop its own work at its deadline. A test-runner
  timeout alone does not stop a polling loop or a child process. Fixture teardown
  waits for its writers to exit before deleting their files, on both success and
  failure. Use the existing scoped process helper and retain the original failure.
- Keep fixtures local and network-free. Use a tiny local R package, temporary
  projects and temporary output paths. Do not depend on a mutable repository or
  an already-installed user package.
- A skipped real integration is missing evidence. Fast unit tests may skip absent
  tools, but acceptance must run the relevant staged-host, live-Ark, browser or
  packaged-Mac journey explicitly.
- Keep performance measurement separate from correctness. Do not retain tracing
  frameworks or thresholds merely because an old test expects them.

## Alder's high-value journeys

Protect lost edits, atomic save/recovery, external conflicts, concurrent GUI and
agent clients, detach without ownership loss, backend failure/reopen, stale result
rejection, Stop and subsequent execution, reactive semantics, outputs/widgets/
cache, passive inspection, project-local packages and current-source publishing.
For R boundaries, use competing real package versions and notebook bindings that
mask common function names; prove ordinary notebook resolution and continued app
behavior. Do not substitute assertions about `.libPaths()`, environment variables
or private namespace objects for that evidence.
Use native Mac interaction only where menus, dialogs, focus or application
lifecycle are the behavior; internal Electron calls do not prove those details.

Review the relevant tests before adding another. Run focused checks first, then
broaden only for changed seams or unresolved failures. Report what real behavior
ran, what was skipped and what remains unproved. A passing suite does not approve
its own checkpoint; the lead does.
