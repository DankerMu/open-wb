## 1. 实现（仅测试）

- [x] 1.1 一个共享小助手（放在既有 `server-startup-*helpers.ts` 内，不新建设施）：由它构造传给 `startCompiledServerWithRetry` 的 launch（调用点只给 env 等，不能省掉 `orderTrace`），每次尝试在被测托管目录之外取一个新 trace 路径；调用方 env 含 `NODE_OPTIONS` 时直接抛错；返回读 trace 的方法。断言辅助两种：「无监听」（没有 `listening:` / `listener-close:` 行）与「恰主端口一次」（恰一行 `listening:<addr>:<主端口>` 与一行 `listener-close:<主端口>`，无其它监听行）
- [x] 1.2 替换 12 处调用点：`mounts-config.test.ts:560`；`omp-max-processes-config.test.ts:161,224,287,349`；`server-config-vision.test.ts:128`；`server-config-browser.test.ts:143`；`model-proxy-reasoning.test.ts:222`；`server-startup-omp-user.test.ts:130`；`server-startup-private-state.test.ts:251,513`（经 `expectGenericStartupFailure` → `:487`）用「无监听」；`server-startup-private-state.test.ts:390`（`reason:"sandbox_root"`，失败在主端口绑定之后，`server.ts:528-530` 先于 `:562-567`）用「恰主端口一次」，预览从未绑定。全部经 1.1 的助手启动
- [x] 1.3 删除 5 份 `refused()` 副本与 `server-startup-order-helpers.ts` 的 `expectRefused`（见 2.3）
- [x] 1.4 原有退出码、stdout、stderr 逐字、托管目录不存在等断言保持不变

## 2. 证据

- [x] 2.1 变异（不提交）：在 `server/src/server.ts` 的 `runEntrypoint` 开头、`resolveServerConfig` 之前插入 `net.createServer().listen(0, "127.0.0.1", function () { this.close(); })`，以 2.2 的完整 `test:focus` 命令运行，记录 12 处调用点（含 `mounts-config` 的全部 `it.each` 行）每一处都变红且失败信息带出 `listening:` 行、`:390` 因监听行多于预期变红；同时确认这些用例的退出码 / stdout / stderr / 托管目录断言在变异下仍通过（红只来自 trace 断言）；恢复后全绿
- [x] 2.2 `npm run test:focus --workspace server -- mounts-config omp-max-processes-config server-config-vision server-config-browser model-proxy-reasoning server-startup-omp-user server-startup-private-state` 通过
- [x] 2.3 `grep -rn "refused(" server/test` 在上述 7 个文件中无命中；`grep -rn "expectRefused" server/test` 除 `fake-upstream*.test.ts` 自带的同名函数与 store 类文件（connectors-store / experts-store / models-store* / workspace-snapshots-torn / turn-control-slash / session-prompt-attachments*）外无命中——`server-startup-order-helpers.ts` 的 `expectRefused` 随在范围内的调用方（`server-startup-omp-user.test.ts:130`、`server-startup-private-state.test.ts:390,487`）全部替换后删除

## 风险包

- Concurrency / shared state / ordering：选中——根因是并行测试共享端口空间；每次尝试新 trace 路径防重试串记录（1.1、2.1）。
- Error handling / rollback：不选——不改产品错误路径，只换证据来源；原有失败记录断言保留（1.4）。
- File IO / path safety：不选——trace 文件放在被测托管目录之外，只读断言（1.1）。
- Legacy compatibility：不选——只改测试；`fake-upstream*` 探针与 store 测试里同名 `expectRefused` 明确不动。
- Public API / Config / Schema / Auth / Resource limits / Release / Documentation：不选——不涉及接口、配置、数据格式、权限、资源上限、打包或文档。

## 必须保持

- 各用例原有断言逐字不变（退出码 `{code:1, signal:null}`、stdout 为空、stderr 恰为失败记录、托管目录不存在、`compiled.root/var` 不存在）。
- `startCompiledServerWithRetry` 的重试语义不变（config 类失败不重试；因此「每次尝试新 trace」在这些用例里走不到，属防御性写法，无可观察证据——已知残余）。
- `server-startup-private-state.test.ts:390` 原意「主端口在进程退出后被释放」（http-service-skeleton spec:45）由 `listener-close:<主端口>` 承载。

## 验证

- `make check`
- `openspec validate startup-refusal-listen-trace --strict --no-interactive`
