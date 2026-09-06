# Tests

- Test observable behavior with independently derived expected results.
- Prefer small, deterministic tests with precise assertions; avoid unnecessary
  mocks, timing assumptions, network access and shared state.
- For a bug fix, demonstrate that the regression fails before the fix (or under
  a temporary mutation) and passes afterward. Never weaken coverage to pass.
- Run focused tests first, then the full feasible suite for behavioral changes.
- Report commands, results and validation gaps. Surface ambiguous behavior or
  probable production defects instead of silently assuming an expected result.
