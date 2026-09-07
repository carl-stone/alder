# Tests

- Test observable behavior with independently derived expected results.
- Prefer small, deterministic tests with precise assertions; avoid unnecessary
  mocks, timing assumptions, network access and shared state.
- Exercise the production host, Ark and retained pure R APIs; do not archive or
  recreate retired implementations for tests.
- Review code before running tests. Reuse existing behavioral cases where
  possible; do not require mutation exercises or add redundant regressions.
- Run the suites appropriate to the change. Repeat checks only for new changes,
  failures or unresolved concerns. Never weaken coverage to pass.
- Report commands, results and validation gaps. Surface ambiguous behavior or
  probable production defects instead of silently assuming an expected result.
