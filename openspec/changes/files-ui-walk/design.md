## Context
Issue133 follows129/130/132. Browser journey is one serial Chromium test; real held dialogue and exact two /api/auth/me401 events are protected.
## Goals / Non-Goals
Change surface: web/e2e/ui-walk.spec.ts; no product or config changes.
Must preserve: four route/current-nav checks, real held chat reload/recovery protocol, service identity, theme persistence, logout, exact browser-error oracle and time bounds.
Must add: UI selection/creation of smoke-fixture, exact files/previews/root directory creation and selected-ID persistence.
Governing invariant: successful journey means real server-backed workspace and content survived reload, not only matching DOM shells or stale URL text.
Sibling surfaces: files picker/dialog/tree/preview, tracked smoke fixtures, API workspace identity, auth oracle, held dialogue and caller-owned runtime.
## Decisions
Use existing accessible UI labels scoped to tree/preview/dialog. Wait for list readiness before branching on workspace existence.
Disk fixtures do not create a DB row. Create smoke-fixture through UI when absent; select exact existing row otherwise.
After selection wait for actual three root file buttons; root toggle alone is insufficient readiness.
Markdown must show exact heading smoke-fixture; source mode must show # smoke-fixture and row number; return render mode if useful.
CSV must show name/value headers, alpha/1 and beta/2 data and two-row indicator; table existence alone insufficient.
Create walk-out at root via UI, verify directory (not file) row, capture actual nonempty ws before reload and assert same ws, selected name and restored files/directory afterward.
Caller supplies fresh sandbox with walk-out absent. No delete, random-name substitution, 409 swallowing or selecting existing walk-out as creation proof.
Keep files sequence after four-route traversal and before held dialogue. No network mocks, route.fulfill or synthetic browser response for acceptance.
## Required Evidence
Main builds web/server and owns real omp18.0.10 plus controlled loopback fake-upstream and isolated DB/sandbox. Run same make ui-walk used by CI.
Negative control mutates only owned sandbox Markdown heading: real journey must fail exact preview assertion. Restore tracked bytes then full journey GREEN; CI independently exercises clean creation branch.
Capture real browser screenshots for rendered/source/CSV/directory-reload surfaces; zero unexpected console/page errors. Existing oracle remains exact2unauthorizedME.
Static/type/drift narrow checks exit0; expanded independent reviews frozenhead; exactheadCIgreen then merge and selectivearchive.
## Risks / Trade-offs
Not idempotent directory creation: acceptance explicitly requires caller-owned fresh sandbox. Existing workspace selection can be covered after negativecontrol created row but failed before mkdir.
30s test/60s global budgets remain unchanged; use observable readiness not sleeps/retries.
No product/security improvements or alternate preview paths in this slice. Image presence required, image-preview behavior is a non-goal.
