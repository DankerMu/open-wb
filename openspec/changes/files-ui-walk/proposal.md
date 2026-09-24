## Why
#133 must turn the already implemented files surface into observable real-browser acceptance, using #129 UI and #130 tracked fixtures. Current journey only visits the route.

Issue type: test
Fixture level: expanded
Upstream suggested level: none (override: project-profile explicitly expands Playwright/shared UI harness and persisted navigation changes).
Blast radius: the one production Chromium journey and its strict auth/error evidence.
Selected risk packs: script entry; file IO; auth; ordering; resource/time bounds; compatibility; error handling; documentation.
Evidence floor: real local make ui-walk plus exact-head CI, semantic wrong-fixture RED then restored GREEN, screenshots and unchanged error oracle.

## What Changes
Add a files segment after four-route traversal, before held dialogue, in existing web/e2e/ui-walk.spec.ts only. Select/create workspace through UI; assert exact preview data, create root walk-out, reload same ws/tree.

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- files-harness: formal files UI journey.
- verification-harness: additive files segment while preserving every current UI scenario.

## Impact
No product, server, fixture, workflow, dependency, retry, timeout or browser-error oracle change. Caller owns fresh isolated sandbox with tracked fixture and absent walk-out; an existing workspace record may be selected, but existing walk-out must not masquerade as successful creation.
