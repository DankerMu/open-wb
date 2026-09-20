## ADDED Requirements

### Requirement: 沙箱 facade 与拒绝审计
`createSandbox({rootOf,audit})` SHALL expose synchronous `resolve(principal,workspaceId,relPath,op)` returning the permitted absolute path and the existing `ensureSharedDir(absPath)`. The rootOf port SHALL be core-owned and receive the supplied principal unchanged; its synchronous result SHALL be absolute root or null. core/sandbox SHALL NOT import feature modules. A null root SHALL throw canonical HttpError(not_found) before path inspection and SHALL NOT emit audit. A rejected underlying resolve SHALL synchronously complete `audit.emit({kind:"sandbox.reject",actorId:principal.id,workspaceId,title:"越界访问被沙箱拦截",detail:{relPath,op,reason}})` before throwing canonical HttpError(sandbox_denied). The audit port SHALL use the existing synchronous numeric-returning core/audit event contract. Audit/lookup errors SHALL propagate unchanged with no successful path or filesystem mutation; generic HTTP failure mapping belongs to the later route integration.

#### Scenario: 不可见根先于路径检查
- WHEN rootOf returns null and the requested relPath is an escape attempt
- THEN resolve throws canonical not_found, emits no audit and does not inspect or modify a target path; missing and foreign roots have the same result

#### Scenario: 合法路径与原有目录助手
- WHEN rootOf yields a real temporary root and resolve receives a legal nested read/list path
- THEN resolve returns its canonical absolute path, no rejection event is emitted, and no filesystem entry is created
- WHEN ensureSharedDir is called through the facade for new nested directories below an existing parent
- THEN new directories have mode2770 and the existing parent's mode and contents remain unchanged

#### Scenario: 真正拒绝先完成审计
- WHEN a permitted root receives traversal or a real symlink path that the existing resolver rejects
- THEN exactly one sandbox.reject event records the actor, workspace, original relPath/op and nonempty reason before the caller receives sandbox_denied; no target content or directory is created

#### Scenario: 端口失败不放行
- WHEN audit.emit throws a sentinel error during rejection
- THEN the caller receives that same error rather than sandbox_denied or a successful path, and filesystem state remains unchanged
- WHEN rootOf throws a sentinel error
- THEN that same error propagates and no audit event or path side effect occurs
