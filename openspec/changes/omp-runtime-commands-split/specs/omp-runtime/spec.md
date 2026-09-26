# Spec delta: omp-runtime（#452 纯搬迁拆分）

## ADDED Requirements

### Requirement: omp 运行时源码模块划分
`server/src/sessions/omp/` 下的运行时实现 SHALL 保持每个源文件 ≤800 行（`scripts/size-guard.sh`）。`SessionRuntime` 的模块级内部辅助（waiter 与 generation/turn 结构、子进程存活与 stdio 辅助、延时竞速、deferred 与帧判定辅助）SHALL 落在 `omp/commands.ts`，由 `omp/runtime.ts` 引用。拆分 SHALL 为纯搬迁：`SessionRuntime`、`OmpProcess`/`spawnOmp` 的公开签名、帧次序、错误类型与日志不变，对外导出集合与导入路径不变，新模块只承载被搬迁的内部辅助、不新增未被引用的导出。

#### Scenario: 拆分后行为不变
- **WHEN** 拆分完成后运行 runtime/process 的既有测试文件（不做任何改动）、`bash scripts/size-guard.sh` 与 `knip`
- **THEN** 既有测试全绿，size-guard 退出 0，knip 无新增未引用导出或文件
