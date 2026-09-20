## Context
Change surface: server/src/core/sandbox/index.ts plus paired tests; no prior facade exists.
Existing resolve.ts and dirs.ts are synchronous and remain canonical; core/audit emit(db,event) synchronously returns numeric row ID. core/errors supplies sandbox_denied/not_found.
Governing invariant: no denied authorized path returns success; every sandbox_denied follows completed audit, and missing/foreign roots produce no rejection event.

## Goals / Non-Goals
Goals: injected root lookup, canonical absolute-path result, exact rejection event, fail-closed audit ordering, expose existing directory helper.
Non-goals: real owner lookup/store, HTTP403/404/500 delivery, production app assembly, async audit backends, DB transactions, new resolver policy or TOCTOU hardening.

## Decisions
1. createSandbox({rootOf,audit}) returns resolve(principal,workspaceId,relPath,op): string and ensureSharedDir. A core-owned structural principal requires id only; preserve the original object for rootOf, without importing auth/workspaces.
2. rootOf is synchronous (principal,workspaceId)=>string|null. null throws canonical not_found before underlying filesystem/path resolution. Lookup exceptions propagate unchanged; no catch-all conversion or audit.
3. Audit port reuses Parameters<typeof canonicalEmit>[1] and ReturnType<typeof canonicalEmit> (number) via type-only core/audit import or equivalent direct canonical derivation. Do not use void, which accepts async implementations in TypeScript. No new event schema; wrappers can bind db at #128.
4. Call existing resolve once for a non-null root. Success returns absPath with no event. Failure calls audit.emit({kind:'sandbox.reject',actorId:principal.id,workspaceId,title:'越界访问被沙箱拦截',detail:{relPath,op,reason}}) then throws canonical sandbox_denied. No broad catch: thrown audit object propagates intact.
5. expose the existing ensureSharedDir directly; no duplicate permissions algorithm, wrapper policy or re-export aliases for old code.
6. Test external ports only with stubs. Real underlying resolver sees temp roots and actual symlinks; preserve raw relPath/op and nonempty reason in event. Null+escape demonstrates precedence; no fabricated HTTP server needed.
7. Issue's source-grep test proposal is replaced with explicit Main/static-review import-boundary verification; avoid permanent assertions on source text while preserving no-feature-import rule.

## Sibling surfaces / evidence
resolve.ts: existing vector tests stay unchanged; facade tests add legal nested path, traversal, real symlink rejection, and no created entries.
dirs.ts: facade entry creates real nested directory with new2770 modes while existing parent remains unchanged; no function-identity assertion.
core/audit: canonical synchronous port shape, exact event fields; canonical errors preserve runtime identity from core/errors. HTTP mapping already #115, not reimplemented.
Downstream #125 rootOf returns owned root|null; #127 consumes absolute path, #128 binds canonical emitter. No current production callers to migrate.
Focused semantic RED distinguishes setup missing-module from callable wrong behavior; major claims each have failing observable oracle before implementation.
Main compiled smoke exercises real root/symlink with capture audit, missing-root precedence, synchronous audit failure and directory mode. Independent CI supplies Linux evidence.

## Risks / Trade-offs
Synchronous-only audit is intentional current SQLite contract; any future async port is a separate explicit API change, not silently accepted by void typing.
Trusted root and stable filesystem assumptions remain from #112; no race prevention or production authorization claim beyond invoking rootOf.
Stub audit proves ordering/event construction, not persistence; real DB integration remains #127. Exact reason wording is not a stable API assertion.
Rollback: revert atomic feature PR through normal protected path; no schema or persistent state migration introduced.
