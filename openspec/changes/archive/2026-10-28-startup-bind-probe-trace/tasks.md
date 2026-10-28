## 1. 实现（仅测试）

- [x] 1.1 A 组删 bind（trace 逐字断言保留，diff 只删 bind 行）：`server-startup-order.test.ts:315-316`；`server-startup-preview.test.ts:189-190, 342-343, 360-361, 385, 502-503, 535-536, 579-580`；`server-startup-office.test.ts:470-471`（行号以 issue 的 bf8ec01f 为准，按内容定位）
- [x] 1.2 B 组加 trace 并断言（`server-startup-failure-reason.test.ts`、`server-startup-layout.test.ts`）：
  - 从未监听 → `expectNeverListened`：failure-reason `:174`（model_registry）、`:418`（#909 config）
  - 仅主端口 → `expectMainPortListenedOnce`：`:271`、`:286`、`:393`（state_layout）、`:311`（sandbox_root，it.each 两行）
  - 主端口绑定 + 预览绑定失败：`:261`（preview_listen；故意占住预览端口、不走重试包装器——全文唯一允许直接给 `startCompiledServer` 传每次新取 `orderTrace` 的例外）→ 监听行恰为 `listening:127.0.0.1:<port>`、`listener-close:-`、`listener-close:<port>`（与 `server-startup-preview.test.ts` 既有形状一致）
  - 两个端口都绑定并关闭：`:347`（mcp_json）、`:374`（publish，需 stdout fd，走扩展了 stdout 的 `startListenTraced`）、`:363-364`（preview_cache，每次尝试异步新取 `PREVIEW_PORT`，走允许异步 `launchFor` 的 `startListenTraced`，逐字）；`PREVIEW_PORT` 为 0 的按形状匹配预览端口
  - 除 `:261` 外，B 组全部经 `startListenTraced` 启动（`:174`、`:418` 尤其不得绕开）
  - `server-startup-layout.test.ts:108` 的 `expectGenericStartFailure`：按 reason 分支（state_layout 仅主端口；host_overlay 两端口）
- [x] 1.3 共享助手与断言（放在 `server-startup-order-helpers.ts`，与 #1821 的助手同处）：`startListenTraced` 的 `launchFor` 允许返回 Promise（`:363` 每次尝试新取 `PREVIEW_PORT`），并支持 `stdout`（`:374`）；仍由助手注入 trace、拒绝调用方 `NODE_OPTIONS`，#1821 的既有调用点不受影响。断言补「主端口 + 预览绑定失败」与「两端口都绑定并关闭」两种
- [x] 1.4 删除 `server-startup-helpers.ts` 的 `expectBindable`（确认无其它调用方）

## 2. 证据

- [x] 2.1 变异 1（不提交）：把 `server/src/server.ts` 失败清理中主实例（`closeOwnedInstance` 的 `which === "app"`）的 `await instance.close()` 换成 `instance.server.unref()`；先确认进程仍以 1 退出、不挂住；运行 2.3 的 test:focus，记录 B 组主端口绑定过的各例（failure-reason `:261, :271, :286, :311×2, :347, :363, :374, :393`，layout `:108` 两个 reason）全部因缺 `listener-close:<主端口>` 变红；另在 origin/master 的旧写法上跑同一变异，记录这些用例的 `expectBindable` 仍通过
- [x] 2.2 变异 2（不提交；规格中由 #1821 的既有要求覆盖，这里取证）：`runEntrypoint` 开头插 `net.createServer().listen(0, "127.0.0.1", function () { this.close(); })`；failure-reason `:174, :418` 因 `listening:` 行变红；office `:470-471`、preview `:502-503` 因既有 trace 逐字断言变红
- [x] 2.3 `npm run test:focus --workspace server -- server-startup-failure-reason server-startup-layout server-startup-order server-startup-preview server-startup-office` 通过
- [x] 2.4 `grep -rn "expectBindable" server/test` 无命中；A 组 `git diff` 只含删除的 bind 行（及因此不再使用的 import）

## 风险包

- Concurrency / shared state / ordering：选中——根因是并行测试共享端口空间；trace 每次尝试新路径（1.2、1.3、2.1）。
- Error handling / rollback：不选——不改产品失败清理，只换证据来源；变异 1 证明新断言能抓漏关回归（2.1）。
- File IO / path safety：不选——trace 文件放在被测托管目录之外。
- Legacy compatibility：不选——只改测试；A 组既有 trace 逐字断言不动（2.4）。
- Public API / Config / Schema / Auth / Resource limits / Release / Documentation：不选——不涉及。

## 必须保持

- 各用例原有的退出码、stdout、stderr 逐字、托管目录、DB 断言不变；A 组 trace 逐字断言不变。
- `startCompiledServerWithRetry` 重试语义不变；`:261` 故意占住预览端口的用例不走重试包装器。
- 产品 spec（http-service-skeleton :45 / :348、office-preview :171）措辞不变，由 verification-harness 新要求说明其测试判据。

## 验证

- `make check`
- `openspec validate startup-bind-probe-trace --strict --no-interactive`
