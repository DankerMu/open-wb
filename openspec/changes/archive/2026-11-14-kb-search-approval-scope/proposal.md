# Proposal: kb-search-approval-scope

```text
Issue type: security / availability fix（#2011）
Fixture level: expanded
Upstream suggested level: (issue 未标) expanded —— 改 omp 子进程治理与审批放行（AGENTS.md Critical Paths），并新增一个 HTTP 错误码
Blast radius: OmpProcess 的 `Allow tool: kb_search` 传输层放行条件；`set_host_tools` 注册冲突的错误分类与 HTTP 映射。
  做错时：放行收得过紧（宿主真注册了 kb_search 却每次弹审批，write 档检索体验退化），或仍放行项目层同名工具（审批绕过照旧）；
  冲突误分类（别的 `success:false` 也成了 409，或冲突仍是 502）；omp 原始错误文本泄进响应、日志或审计
Selected risk packs: Auth / permissions / secrets; Error handling / rollback / partial outputs; Public API（新错误码）;
  Legacy compatibility（知识库开着、宿主注册成功的部署，帧序与行为逐字不变）; Concurrency / shared state / ordering（注册状态随应答更新的时序）
Evidence floor: OmpProcess 单测（放行三态：从未注册 / 注册成功 / 撤下后）；slot 层假 omp 帧序；冲突 → 409 与其它失败 → 502 的对照；
  三个真实 omp 门控同名用例翻转为新期望；`make check`；CI 全绿
```

## Why

#2004 在官方 omp v18.12.3 上实测（`docs/reviews/2026-11-10-omp-host-tools.md` §2.10）：会话工作空间里有项目层同名工具
`.omp/tools/kb_search.js` 时，

1. **所有者有库**：omp 以 `RPC host tool "kb_search" conflicts with an existing tool` 拒绝 `set_host_tools`，宿主按「注册失败」处理成
   502 `agent_unavailable`，下一条 prompt 起新进程再撞一次。该工作空间一直不可用，错误也无从诊断。
2. **这一代进程没有注册 host tool**（知识库关闭的部署，或所有者没有库）：项目工具的确认卡标题同为 `Allow tool: kb_search`，
   `server/src/sessions/omp/process.ts:603` 的放行只看档位与标题，`write` 档下传输层立即答 `Approve`。项目工具的 `execute()` 不经审批运行，
   输出以 `kb_search` 步骤、知识库检索结果的名义出现，所有者不知情。知识库关闭的部署里，这对所有账号、任何时刻都成立。

Owner 裁定（2026-11-14，#2011 评论）：「收紧放行+可诊断错误」。

## What Changes

- **tool-approval「审批请求识别」**：`kb_search` 的传输层放行加一个前提——这一代进程上一次成功的 `set_host_tools` 应答把 `kb_search` 列在 `toolNames` 里。
  不满足时，同形的 select 按审批识别照常交给所有者（`tool="kb_search"`），`write` 档也一样。
- **omp-runtime「`kb_search` 的注册」**：`set_host_tools` 回 `success:false`，且 `error` 恰为 v18.12.3 的冲突文本时，这一步按新码
  409 `kb_tool_conflict` 失败；其余失败照旧 502 `agent_unavailable`。两种失败都退役 slot、补偿受理。omp 的错误原文不进响应、日志、审计。
- **http-service-skeleton「统一错误信封」**：新码 `kb_tool_conflict`（409，文案见 design D3）。
- **omp-runtime「host tool 的真实 omp 回归」**：「项目层同名工具」场景改为新期望——有库时 409 `kb_tool_conflict`；
  知识库关闭或没有库时，`write` 档下项目工具的确认卡作为审批交给所有者。

## Impact

- 规格：MODIFIED——tool-approval「审批请求识别」、omp-runtime「RPC IO and child observation」「`kb_search` 的注册」「host tool 的真实 omp 回归」、
  session-permission-tier「档位与 omp 审批模式」、chat-sessions「派发前按会话设置对齐进程」、omp-test-harness「假 omp host tool 场景」、
  http-service-skeleton「统一错误信封」（码表三十七 → 三十八）。
- 文档：`openspec/glossary.md`「host tool」的「放行」定义、`docs/architecture/system.md:31` 码数、`docs/acceptance/functional-checklist.md` 新增行（`待签`）。
- 代码：`server/src/sessions/omp/`（放行判定与注册状态、错误原文的携带）、`server/src/sessions/host-tool-align.ts`（冲突分类）、
  `server/src/core/errors/index.ts`、`server/src/http/errors.ts`；测试与假 omp 场景；`docs/architecture/knowledge-base.md`、实测记录 §2.10。
- 不动：web（信封文案原样展示，`web/src/features/chat/errors.ts:12`）、知识库模块、档位语义、`always-ask` 行为、ADR-0012 的已接受残余
  （项目层工具在 spawn 时执行仍不拦）。
- Critical Path：omp 子进程治理（审批放行）。PR 标注请求白盒审查。
