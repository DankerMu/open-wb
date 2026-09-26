# Spec delta: omp-runtime（#452 纯搬迁拆分）

## ADDED Requirements

### Requirement: omp 运行时源码模块划分
`server/src/sessions/omp/` 下的运行时实现 SHALL 保持每个源文件 ≤800 行（`scripts/size-guard.sh`）。`omp/commands.ts` SHALL 承载 `SessionRuntime` 的模块级辅助（waiter 与 generation/turn 结构、子进程存活与 stdio 辅助、延时竞速、deferred 与帧判定辅助）以及 command/abort/pending 计时面，由 `omp/runtime.ts` 引用；它 SHALL 不新增未被引用的导出，且对 `runtime.ts` 只有类型导入。`SessionRuntime`、`OmpProcess`/`spawnOmp` 的公开签名与导入路径 SHALL 保持在 `runtime.ts`/`process.ts`。

#### Scenario: 模块划分可持续验证
- **WHEN** 运行 `bash scripts/size-guard.sh`、`knip` 与 server 测试
- **THEN** size-guard 退出 0，knip 无未引用导出，`runtime.ts` 从 `./commands.js` 引用上述辅助而 `commands.ts` 对 `./runtime.js` 只有 `import type`，runtime/process 测试全绿
