# Testing Guidelines 

Tests are attempts to falsify the code, not demonstrations that it runs. 

## Write meaningful tests 

- Test externally observable behavior and public contracts, not implementation details. 
- Derive expected results independently. Do not reproduce the implementation or use the function under test to calculate its own expected value. 
- Every test should fail for a plausible defect. If you cannot explain what bug it detects, reconsider it. 
- Assert meaningful values, structure, state changes, and errors precisely. “Does not throw,” type checks, existence checks, and snapshots alone are usually insufficient. 
- Cover representative normal behavior, important boundaries, invalid inputs, and known failure modes. Do not add cases mechanically when they provide no new information. 
- Add a regression test for every bug fix. It must fail before the fix and pass afterward. 
- Prefer small, deterministic tests. Avoid unnecessary mocks, timing assumptions, network access, shared state, and broad snapshots. 

## Evaluate the tests 
- Run each new test against the relevant code. 
- Verify that the test can detect the defect it claims to cover: run it against the pre-fix code or make a minimal temporary mutation, confirm failure, then revert the mutation. 
- Check that failures are specific and understandable rather than incidental. 
- Run the focused tests first, then the full feasible test suite. 
- Do not weaken assertions, delete coverage, or update snapshots merely to make tests pass. 
- When a test exposes ambiguous intended behavior or a probable production bug, report it rather than encoding an assumption silently.

Report the commands run, results, and any validation that could not be completed.
