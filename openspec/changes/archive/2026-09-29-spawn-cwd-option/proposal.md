# Proposal: spawn-cwd-option（#513）

## Why
父 change `s1c-session-metadata-presentation` tasks 2.1（epic #509，design D4 两刀的第一刀：签名首刀可选、2.2 后刀必填）。会话绑定工作空间后，omp 子进程要以空间根为工作目录；现行 `spawnOmp`（`server/src/sessions/omp/process.ts:59`）固定 `cwd = join(sandboxRoot, ownerId)` 并对其 `mkdir -p`，`SessionRuntime` 无法传入其它 cwd。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded
Blast radius: 生产 omp spawn 的 argv 与子进程工作目录（AGENTS.md Critical Path「omp 子进程治理」）；缺省值写错会让所有会话 cwd 漂移或所有者根不再被建出（首个 prompt spawn 失败）；「非所有者根 cwd 不 mkdir」写错会让 2.2 的「空间根缺失不创建」前提失效。
Selected risk packs: Public API / CLI / script entry（spawn argv 与 `SpawnOmpOpts`/`SessionRuntimeOpts` 签名）；File IO / path safety / overwrite（mkdir 范围）；Legacy compatibility / examples（缺省行为逐字不变、既有 spawn 契约测试零改动）；Auth / permissions / secrets（sudo 模式 argv 位置与 env 白名单不变）
Evidence floor: 新建 `server/test/omp-spawn-cwd.test.ts` 覆盖 design「Required evidence」；`omp-process.test.ts`、`sudo-launcher.test.ts`、`omp-runtime*.test.ts`、`omp-rpc*.test.ts`、`server/test/support/omp-rpc.ts` 零改动全绿；`npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0；PR head CI（含 `uid-isolation`）绿。

## What Changes
- `process.ts`：`SpawnOmpOpts.cwd?: string`；`spawnOmp` 以 `cwd = opts.cwd ?? ownerRoot` 为 argv `--cwd` 与 spawn 选项 `cwd` 的同一变量；只有 `resolve(cwd) === resolve(ownerRoot)` 时 `ensureSharedDir(ownerRoot)`，session-dir/home/agent 照旧。
- `runtime.ts`：`SessionRuntimeOpts.cwd?: string`，经 `#openProcess` 透传（未提供时不传键，由 `spawnOmp` 缺省）。为守 ≤800 行（797 + 4 = 801，搬迁必需），把 `runtime.ts` 末尾的纯辅助函数 `nonempty` 原样移入 `commands.ts` 并导出（不搬 `sanitizeError`：它要值导入 `SessionBusyError`，会形成 runtime ↔ commands 运行时循环依赖）。
- 新建 `server/test/omp-spawn-cwd.test.ts`。不改任何调用方（supervisor/pool 不传 `cwd`）与测试夹具。

## Capabilities
- MODIFIED `omp-runtime`「子进程 spawn 契约」：以当前主 spec 为底，只并入 spawn 侧三点——argv `--cwd <CWD>`（`<CWD>` 为调用方传入、缺省所有者根，spawn 不自行拼接其它来源路径）、「子进程的工作目录 SHALL 等于同一 `<CWD>`」（父 delta 原句）、mkdir 范围（父 delta 原句，另加一句「其它 cwd SHALL NOT 由 spawn 创建」）；Scenario「参数与目录」取父 delta 原文。父 delta 中按 `workspace_id` 取值、`rootOf` 解析失败不 spawn、绑定空间根存在性检查、fork/regenerate 的 `<CWD>` 取值、resume 以文件头 cwd 为准的段落，与 Scenario「Effective child boundary」修订、「绑定空间的会话以空间根为 cwd」「绑定空间根缺失时不创建不 spawn」「resume 以会话文件头的 cwd 为准」属 2.2，留给它（2.2 以父 delta 全文替换本刀的过渡措辞）。

## Impact
- `server/src/sessions/omp/{process.ts,runtime.ts,commands.ts}` 与一个新测试文件；无 REST/前端/迁移改动；sudoers 行不变（`--cwd` 值在 `opts.bin` 之后的 omp 参数段）。

## Non-goals
- supervisor 按会话绑定解析 cwd、`workspaceRootOf`、空间根存在性检查、`cwd` 必填化（2.2）；probe `cwd=`（6.2 已交付）。
