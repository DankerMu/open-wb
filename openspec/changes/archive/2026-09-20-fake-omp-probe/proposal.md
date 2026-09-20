## Why

Issue #121 supplies the real-process measurement carrier needed by Epic #111 Linux isolation tests. #87 is merged; the existing fake omp can report protocol behavior but cannot yet measure its own identity and filesystem access.

## What Changes

- Add prompt-selected probe reporting to the existing standalone fake omp and real-child contract tests.
- Preserve every non-probe scenario; no production changes or dependencies.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `omp-test-harness`: add the probe reporting contract without claiming cross-uid isolation.

## Impact

`server/test/support/fake-omp.mjs` and `server/test/fake-omp.test.ts`; future consumers #131/#132. Parent D10 and task 5.3 govern this slice.

Issue type: test
Fixture level: expanded
Upstream suggested level: expanded (agree: file IO, script protocol, security measurement carrier)
Blast radius: false probe results could invalidate later uid isolation evidence.
Selected risk packs: script entry; file IO; field names; permissions/secrets; ordering; legacy compatibility; error handling; documentation.
Evidence floor: TDD through a real child, focused Vitest, server regression suite, static gates, actual child smoke; Linux CI must prove same-uid environ=readable. macOS does not prove Linux isolation.
