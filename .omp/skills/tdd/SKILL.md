---
name: tdd
description: Test-driven development with red-green-refactor loop. Use when user wants to build features or fix bugs using TDD, mentions "red-green-refactor", wants integration tests, or asks for test-first development.
version: 0.1.0
---

# Test-Driven Development

## Core Rule

Tests verify **behavior through public interfaces**, not implementation details. A test that breaks on refactor but not on behavior change is wrong. See [tests.md](tests.md) and [mocking.md](mocking.md) for examples.

## Anti-Pattern: Horizontal Slices

**DO NOT write all tests first, then all implementation.** This is "horizontal slicing" - treating RED as "write all tests" and GREEN as "write all code."

Tests written in bulk test _imagined_ behavior — they outrun your headlights.

**Correct approach**: Vertical slices via tracer bullets. One test → one implementation → repeat. Each test responds to what you learned from the previous cycle.

```
WRONG (horizontal):
  RED:   test1, test2, test3, test4, test5
  GREEN: impl1, impl2, impl3, impl4, impl5

RIGHT (vertical):
  RED→GREEN: test1→impl1
  RED→GREEN: test2→impl2
  RED→GREEN: test3→impl3
  ...
```

## Workflow

### 1. Planning

Before writing any code:

- [ ] Confirm with user: what interface changes are needed?
- [ ] Confirm with user: which behaviors to test? (You can't test everything — prioritize critical paths)
- [ ] Identify [deep module](deep-modules.md) and [testability](interface-design.md) opportunities
- [ ] List behaviors to test (not implementation steps)
- [ ] Get user approval on the plan

### 2. Tracer Bullet

Write ONE test that confirms ONE thing about the system:

```
RED:   Write test for first behavior → test fails
GREEN: Write minimal code to pass → test passes
```

This is your tracer bullet - proves the path works end-to-end.

### 3. Incremental Loop

For each remaining behavior:

```
RED:   Write next test → fails
GREEN: Minimal code to pass → passes
```

Rules:

- One test at a time
- Only enough code to pass current test
- Don't anticipate future tests
- Keep tests focused on observable behavior

### 4. Refactor

**Never refactor while RED.** Get to GREEN first, then look for [refactor candidates](refactoring.md):

- [ ] Extract duplication / deepen modules
- [ ] Consider what new code reveals about existing code
- [ ] Run tests after each refactor step

## Checklist Per Cycle

```
[ ] Test describes behavior, not implementation
[ ] Test uses public interface only
[ ] Test would survive internal refactor
[ ] Code is minimal for this test
[ ] No speculative features added
```
