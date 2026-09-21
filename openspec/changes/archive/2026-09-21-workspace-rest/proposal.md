## Why
Issue #127 exposes the already-merged store, sandbox and preview capabilities through five authenticated REST endpoints. Real DB/FS/audit boundaries must agree before production bootstrap (#128).
## What Changes
- Add workspaces/index.ts + rest.ts registration and complete real-app integration tests; no app.ts/server.ts production wiring.
- Inject the already-constructed canonical store: registerWorkspaces(app,{store,sandbox,audit}), with audit the same bound synchronous number-returning emitter used by the facade. This reconciles the earlier incomplete {db,sandbox,audit} sketch, which cannot supply sandboxRoot. No duplicate store/config source or unused db argument.
- Correct resolver ENOTDIR classification: descendants below an ordinary file are safe but structurally absent, so routes return404 rather than falsely emit sandbox.reject403. Existing escape/symlink/unexpected-error rejection remains.
## Capabilities
### New Capabilities
None.
### Modified Capabilities
- workspaces: add authenticated collection, tree/mkdir and bounded-preview HTTP requirements.
- sandbox-core: clarify safe-path resolution versus non-directory existence, preserving all prior escape rules.
## Impact
Source: workspaces/rest.ts,index.ts; narrow core/sandbox/resolve.ts correction and paired regression. Tests may use one focused workspaces HTTP fixture helper if needed to stay within800lines; no new dependencies/config/schema. Shared resolver consumers are store+facade (Main LSP14references). Production assembly remains #128.
## Risk triage
Expanded fixture: tenant filesystem boundary, synchronous audit and streaming HTTP. Critical Path; user waived per-issue human review, retaining finalEpic functional acceptance. One implementer/currentworktree, independent static reviews; no nested agents/peer contact.
