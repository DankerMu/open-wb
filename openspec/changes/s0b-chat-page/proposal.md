## Why
Issue #104 completes Epic #81's browser conversation surface after #92 API and #93 event ownership contracts. `/` remains a placeholder; the browser must own account-bound requests, URL selection and connection cleanup without duplicating the server or connector state machine.

## What Changes
- Deliver conversation list/new action/composer/messages/step cards/status/error surface at `/`, with `?session=` restore and user navigation.
- Consume existing named DTOs, account-bound API and pure reducer/connector; preserve complete text and authoritative snapshot recovery.
- Update root route description and all existing root-rendering test fixtures atomically; retain working files/settings/auth routes.
- Reconcile successful prompt with an authoritative snapshot rather than guessing server title/trim rules or creating speculative message rows.

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `chat-web`: add delivered conversation page requirement.
- `spa-shell`: replace only root placeholder with conversation page, preserving files page and every footer/logout scenario.

## Impact
Candidate scope: web/src/features/chat page/barrel and local page-owned helpers if needed; web/src/routes/router.tsx; paired chat page tests/support; existing routes/main/settings-footer root fixtures. No server/API/parser/stream behavior changes, dependencies, auth provider changes, permanent Playwright scenario or CI changes. Parent planning delta synchronized by orchestrator.

Fixture level: **expanded**, raised from issue's compact suggestion because project-profile explicitly expands createBrowserRouter/auth lifecycle; URL+auth epoch+async prompt/snapshot/SSE span multiple ownership seams. Risks selected: Public API/Schema, Auth, Concurrency, Resource limits, Legacy compatibility, Error handling, Documentation. Domain: browser navigation/runtime, account lifecycle, server/web envelope, offline/cross-service contracts. Verification is parent-owned, source is one implementer/current checkout, no worktrees. Human white-box waiver remains Epic-specific; all agent/CI gates remain.
