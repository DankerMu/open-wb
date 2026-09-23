## Context
Issue128 plus handoffs123/124/125/127/126; user confirmed prerequisites and waived per-issue human review. Current base2006e96 includes #204 synchronous sinks and #126 permission helpers.
Governing invariant: startup identity, actual registration order and reachable endpoints describe one composition using one caller DB and the runtime sandbox root; authorisation precedes sandbox denial/audit.

## Goals / Non-Goals
Goals: auth→httpguard→model-proxy→sessions→workspaces→accounts (DB opened by entry first), exact seven-item startup record, authenticated real routes and lazy owner roots.
Non-goals: new route/store/facade/error implementations, new config/dependency/CI, changes to sudo/user/PATH/DB permissions, actual Linux uid proof, eager sandbox provisioning, app factory bypass flags.

## Decisions
1. app.ts derives one runtime as today and uses runtime.sandboxRoot for createWorkspaceStore(db,{sandboxRoot,ensureSharedDir,emit}). Store emit is raw canonical(db,event)=>number. Bound audit is {emit:event=>emit(db,event)} and createSandbox({rootOf:store.rootOf,audit}) stays synchronous. RegisterWorkspaces(app,{store,sandbox,audit}) then registerAccounts(app,{db}) exactly once.
2. Keep existing model/session token registry, reconciliation, onError/onEvent return forwarding (#204), caller DB lifetime, auth/cookie/guard/error mapper and fallback ordering unchanged. No duplicate sandboxRoot option or injectable store/audit abstraction.
3. Construction is FS-pure: missing sandbox base/u1 remain absent after registration/start; configured root identity survives server→runtime→store. Workspace creation retains #125's trusted, preprovisioned SANDBOX_ROOT base requirement; owner/workspace subdirectories remain lazy. A missing base is allowed at startup but workspace creation then fails closed, not an invitation to add auto-provisioning or chown. Main smoke initially omitted this deployment precondition (500), then provisioned canonical base2770 and observed201 without source changes.
4. Expanded test cutover is required despite old issue's narrow file list: accounts.test.ts manually registers accounts; workspaces-http-helpers.ts manually composes both modules; workspace-http-errors.test.ts shadows both exact production POST routes. Remove those duplicate production registrations, migrate genuine parser tests to real16KiB routes/no DB-audit-FS effects; preserve nonowner/concrete-route/forged-error coverage through appropriate existing native or request-hook seams. Do not add production skip-registration controls or duplicate business logic.
5. Extend existing test helpers only as needed to pass actual assembly runtime config. Keep native preview-error onSend injection before app.ready; verify its existing assertion still observes500/headers/stream cleanup. No test assertion or fault path may be dropped to avoid duplicate-route failures.
6. Seven module order is an explicit issue contract: use existing call-through registration observation with real functions, and link that observed sequence to actual compiled startup output rather than only comparing two duplicated arrays. Production factory itself is not mocked; observe dependencies while calling through.
7. Rebase startup and shared-agent spec blocks from current main, not stale parent. Preserve native timer bound2147483647, missing-upstream401-before502, sticky failure, model-publication cancellation and real proxy-turn secret scenario; reference promoted #120/#126. Parent stays active; slice archive must not roll back already-promoted error/sandbox/workspace semantics.

## Seams and evidence
TDD tracer: real createApp authenticated GET workspace/audit404 before wiring→200 proper shapes/no-store; anonymous401 unchanged; configured absent owner root remains absent.
Real DB/FS through completed app with deployment base preprovisioned: owner create201/list200/root under injected runtime root, another owner404 even traversal with no new sandbox audit, owner's traversal403 with persisted canonical sandbox.reject visible in GET audit. App.close leaves caller DB usable.
Actual compiled entry: exact seven modules tied to call-through order; configured root forwarded, startup lazy, real auth/workspace/audit HTTP requests, SIGTERM0 and port released. No host sudo.
Migration regression: existing account/workspace/native stream and genuine parser tests retain authorization/error/cache boundaries; malformed/empty/media/oversize owned requests400 without workspace/dir/audit mutation, anonymous malformed401/no-store; unowned and forged constructor errors500 not400.
Main qualification: isolated snapshots remove a registration, reverse new registration order, or misbind root/audit if baselineRED alone does not discriminate those boundaries. Full server tests required; fortyish createApp references mean focused-only green is insufficient.

## Risks / Trade-offs
Source/test imported-symbol references via LSP before change; known explicit registrations are accounts.test and workspaces-http-helpers. No path renames or hidden compatibility layers.
Startup-order test is near800 lines; reuse moved #126 helpers, keep source/tests focused and document any necessary coherent test-file move rather than drop coverage.
Scope expands only to callers broken by canonical registration; no unrelated cleanup. Rollback by feature revert via PR, not dual implementations.
Review focus: one root/DB/audit identity; exact registration order vs output; no eager dirs; all duplicate fixture registration removed; promoted-spec preservation.
