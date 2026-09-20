## Context

Change surface: accounts/index.ts and paired route test only. registerAccounts(app:FastifyInstance,{db}):void is a registration seam; caller already installed createApp's auth/guard/error handler. Production app.ts remains unchanged until #128.
Must preserve: core audit exact-role actor filter/id DESC/canonical before semantics; one root authentication pass; canonical core/errors identity; generic unexpected 5xx; existing APIs and parser ownership.
Governing invariant: only the real guard's request-local principal reaches query, with no actor/role accepted from wire; every endpoint response is no-store and query cannot write audit events.
Sibling surfaces: createApp registration order, auth cookie plugin/root preParsing guard, request.principal, core/audit.query, HttpError mapper, route-local onRequest cache hook, future #128 assembly.

## Decisions

- Register GET /api/audit on the supplied app, no nested alternate app/auth/guard or production assembly modification. Read request.principal; if missing fail closed with canonical unauthorized, never call authenticate again or fabricate principal.
- Use route-local onRequest no-store (same lifecycle pattern as auth routes), so root guard's early401 and later400/500 also carry it. Do not add a global cache header or alter unrelated routes.
- No route AJV schema: existing mapper deliberately excludes generic FST_ERR_VALIDATION. Parse wire query minimally; scalar limit string converts with Number and core query validates integer1..200, default50. Scalar before passes byte-for-byte as string to core. Repeated parameters/arrays are bad_request, never silently choose one. Empty limit becomes0 and fails; empty before fails core validation. Unknown keys do not affect authorization or query behavior. No new canonical syntax restriction on limit beyond core numeric contract; before remains strictly canonical.
- Delegate all actor/admin, cursor range and JSON/event mapping to query; return {events}. Do not duplicate database SQL, role checks or cursor Number conversion.
- Unexpected query/DB faults propagate to existing generic500 mapper, not bad_request/empty events. HTTP facade does not own a transaction or database lifecycle.

## Evidence

Real createApp({db}) then registerAccounts before first inject; real openDb(':memory:') and real login/cookie helpers. u1/u2 interleaved events, admin u3; assert exact event shape, JSON detail, ordering and member/admin pages. No mock of query, guard, mapper or system under test.
Named invalid query cases limit0,beforeabc/0/-1 plus limit201/1.5, empty and repeatedlimit/before return400 canonical envelope and no-store. Unauthenticated invalid query remains401 (guard wins). Route query failures via real SQLite authorizer denial yield generic500/no-store, no internal detail leak and unchanged audit rows; auth-path failure classification remains existing behavior.
Wire precision oracle: an explicit audit row at2^53 with before='9007199254740993' includes the row and causes native decoding -> generic500; if the facade rounds Number it incorrectly yields200/safe-only. A separate ordinary-row hugecursor>signed64 yields200 and correct visible events.
Endpoint reads do not append/change audit rows; auth session lifecycle writes are not claimed to be globally absent. Existing production app still returns preexisting fallback for audit until explicitly registered; do not claim shippedbootstrap availability.

## Risks / Non-Goals

No new route schema, global headers, aliases, auth refresh, retention, other account endpoints, dependency, new error codes or current app.ts wiring.
Compiled smoke explicitly composes real app + registerAccounts, listens on localhost ephemeral port, uses real HTTP login/fetch and closes resources; not proof of #128 bootstrap.
Review focus: guard precedence, no-store on all outcomes, scalar query conversion, preserved large-cursor boundary, unchanged generic errors and no production assembly drift.
