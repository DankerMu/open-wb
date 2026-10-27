## Why

挂载主机的系统解析全局限流为 2 个（`attempt.ts` 的 `HOST_LOOKUPS_IN_FLIGHT`），用来保护 libuv 线程池：`dns.lookup` 运行时占一个池线程，没有超时，也无法取消。这个限流不区分账号，所以一个账号用 2 个在途建出（或它离线挂载的重挂解析）指向不应答的 DNS，就能把名额占满，其他账号的主机名解析只能一直排队（#1810，来自 PR #1807 invariant-state 评审的 Note）。

## What Changes

- 解析限流改为两级：
  - 先过账号级：每个账号同时最多 1 个解析在途，多出的在该账号自己的队列里先到先得排队；
  - 再过全局级：全进程最多 2 个解析在途，不变，继续保护线程池。
  - 建出和重挂都按挂载所属的账号计入同一个账号名额。IP 字面量不走解析，也不排队，与现在一致。
- Owner 裁定（2026-10-27）：每账号 1 个、全局 2 个。否决的两个方案：
  - 每账号 2 个、去掉全局上限：两个账号就能占满线程池；
  - 改用 c-ares：不读 `/etc/hosts` 和 nsswitch。
- 不新增配置键。
- `docs/architecture/system.md` 里 #1789 的残余说明按新语义改写。
- MODIFIED workspace-mounts「挂载取值与主机规则」。

## Triage

```text
Issue type: feature (fairness hardening)
Fixture level: expanded
Upstream suggested level: absent
Blast radius: 每次 sftp / smb 的建出与重挂都要经过解析。限流写错有两种后果：账号名额泄漏，该账号此后的解析永远排队；全局名额被绕过，线程池被占满
Selected risk packs: Concurrency / shared state / ordering; Resource limits; Error handling / rollback / partial outputs; Documentation / migration notes
Evidence floor: manager 层用例覆盖同账号串行、跨账号并行、全局 ≤2、重挂计入所属账号、失败或中止后名额释放、IP 字面量不排队；既有两例按新语义更新；make check
```

## Impact

- `server/src/workspaces/mounts/attempt.ts`：`target` 增加 `ownerId` 参数，加入账号级限流。
- `server/src/workspaces/mounts/manager.ts`：两个调用点传入 `record.ownerId` 和 `input.ownerId`。
- `server/test/mounts-manager.test.ts`：两个既有用例按新语义更新，并新增用例；可能需要给 lisi 准备一个正式空间。
- `docs/architecture/system.md`。
