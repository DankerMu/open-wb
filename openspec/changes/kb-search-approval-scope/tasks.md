# Tasks: kb-search-approval-scope

> 单 issue 单 PR（#2011）；fixture 随该 PR 合入，合入后另开 PR 归档。Critical Path（omp 子进程治理、审批放行）：PR 标注请求白盒审查。

## 风险包

| 风险包 | 选中 | 理由 / 落点 |
|---|---|---|
| Auth / permissions / secrets | 是 | 审批放行收紧（D1）；omp `error` 原文不外泄（D2）。1.2、1.3、2.2 的用例 |
| Error handling / rollback / partial outputs | 是 | 冲突与其它注册失败都退役 slot、补偿受理（D2）。2.2 的对照用例 |
| Public API / CLI / script entry | 是 | 新错误码 `kb_tool_conflict`（409）。2.1、`http-typed-errors.test.ts` 的码集断言 |
| Legacy compatibility / examples | 是 | 知识库开着、注册成功的部署：放行、帧序、审计逐字不变；`always-ask`、`yolo` 不变。既有 host tool / 审批用例断言不改 |
| Concurrency / shared state / ordering | 是 | 注册状态随 `set_host_tools` 应答更新，先于确认卡（D1 时序）；撤下与再注册的切换。1.2 的三态用例 |
| Schema / columns / units / field names | 否 | 无表结构改动；`chat_approvals` 写法沿用审批识别 |
| Config / project setup | 否 | 无 |
| File IO / path safety / overwrite | 否 | 不读写工作空间文件；冲突来自 omp 自己加载的项目工具 |
| Resource limits / large input / discovery | 否 | 冲突仍每次重新 spawn（与现状相同），不加熔断（design D2） |
| Release / packaging / dependency compatibility | 否 | omp 冲突文本绑定 v18.12.3；升级改文本时退回 502，由官方门控用例发现 |
| Documentation / migration notes | 是 | knowledge-base.md 审批放行段、实测记录 §2.10、#2011 评论 |

Boundary：
- 可改：`server/src/sessions/omp/process.ts`（只接线，≤ 790 行）、`server/src/sessions/omp/host-tools.ts`、`server/src/sessions/omp/ui-requests.ts`、
  `server/src/sessions/omp/runtime.ts`（只为携带应答 `error`，现 744 行）、`server/src/sessions/host-tool-align.ts`、`server/src/core/errors/index.ts`、
  `server/src/http/errors.ts`；对应测试；`server/test/support/fake-omp-host-tool.mjs`（新场景 `host-tool-register-conflict`，与 `host-tool-register-fail` 同形，
  只换 `error`；`fake-omp.mjs` 现 ≤ 770 行的预算照旧）；`server/test/omp-official-host-tools.test.ts`（翻转三个同名用例）；
  `docs/architecture/knowledge-base.md`、`docs/reviews/2026-11-10-omp-host-tools.md`；
  码数守卫 `server/test/http-error-codes.test.ts:6`、`http-parser-owners.test.ts:77,184,382`、`http-typed-errors-kb.test.ts:78`、`http-typed-errors.test.ts:10,144`；
  `server/test/omp-process-prelude.test.ts:153-178`（先注册再发卡）、`server/test/session-kb-search-approval.test.ts`（见 Must-preserve）；
  `docs/architecture/system.md:31`（码数）、`openspec/glossary.md:106`（「放行」定义）、`docs/acceptance/functional-checklist.md`（新增行，`待签`）。
- 只读：web、知识库模块（`server/src/kb/**`）、CI、Makefile、AGENTS.md、ADR。

Must-preserve：
- 宿主注册成功的 `write` / `yolo` 进程：`Allow tool: kb_search` 照旧立即 `Approve`，不登记、不发事件、不写 `chat_approvals`、不审计（tool-approval 既有场景不改断言）。
- 会改变的既有用例（如实列出）：`session-kb-search-approval.test.ts` 用的是知识库关闭的装配，D1 之后它的 `write` 一例会翻转。处理：保留行为的那三档用例改到「知识库开启、所有者有库」的装配上（断言值不变）；
  另加一例知识库关闭、`write` 档照常出卡（session-permission-tier delta 新场景）。`omp-process-prelude.test.ts:153-178` 的 `write` 例前面补一次成功注册，断言不变。
- `always-ask`：照常交给所有者。只有恰好的标题适用放行（既有场景）。
- `host-tool-register-fail`（`error:"host tools rejected"`）仍是 502 `agent_unavailable`（omp-runtime「注册失败」场景不改）。
- 知识库关闭的部署：没有任何 `set_host_tools`，帧序与改前逐字节相同（omp-runtime「不注册」场景）。
- 浏览器 prelude 卡、审批识别的其它规则与判定顺序不变。
- omp `error` 原文不进 HTTP 响应、日志、审计、SSE。
- 文件 ≤ 800 行；复杂度 ≤ 15；重复 ≤ 3%。

## 1. 放行前提（D1）

- [ ] 1.1 核对 Context：`omp/process.ts:595-620`（`#onUiRequest`）、`#request` / `request`（:242、:340）、`omp/ui-requests.ts`、`omp/host-tools.ts`、
  `host-tool-align.ts:55-88`、tool-approval「审批请求识别」既有 `kb_search` 三个场景所在的测试文件。
- [ ] 1.2 测试先行（红）：OmpProcess 层，`write` 档，同形 select 在三态下的去向——从未成功注册（交给 owner）、以 `["kb_search"]` 注册后（立即 `Approve`）、
  撤下 `[]` 后（交给 owner）、`success:false` 不改状态、撤下后再注册恢复放行。既有「`kb_search` 在 write 档由传输层放行」用例按 delta 先注册再发卡。
- [ ] 1.3 实现：注册状态由进程观察自己的 `set_host_tools` 成功应答更新；放行判定加「已注册」。`process.ts` 只接线（≤ 790 行）。
- [ ] 1.2b 同一层再加一例：id 对不上任何宿主请求的 `response{command:"set_host_tools",success:true,data:{toolNames:["kb_search"]}}` 不改状态，随后的同形卡交给 owner。
- [ ] 1.4 slot 层（假 omp）：知识库关闭的会话、所有者没有库的会话在 `write` 档下，假 omp 发 `Allow tool: kb_search` 时 SSE 有 `approval.request`（`tool:"kb_search"`）。

## 2. 冲突分类与错误码（D2、D3）

- [ ] 2.1 `kb_tool_conflict`：`core/errors/index.ts` 文案、`http/errors.ts` 409；码数守卫（见 Boundary）三十七 → 三十八，`http-typed-errors` 新场景（红→绿）；`docs/architecture/system.md:31` 码数。
- [ ] 2.2 测试先行（红）：假 omp 新场景 `host-tool-register-conflict`（`error` 为冲突原文）→ prompt 409 `kb_tool_conflict`、body 恰为信封；
  对照（`WORKBUDDY_FAKE_CONFLICT_PREFIX=x`，`error` 带前缀）与 `host-tool-register-fail` 仍 502；三者都补偿受理、入站帧无 `prompt`、slot 退役；
  响应、日志行（`world.log` 或等价）、`onError` 收到的错误所产生的输出、审计行与 SSE 都不含 `conflicts with an existing tool`。
  regenerate 路径（chat-sessions delta 场景）：409，没有 `get_branch_messages` / `branch`，旧消息不变。假 omp 场景本身按 omp-test-harness delta 加单测。
- [ ] 2.3 实现：`runtime.#runCommand` 抛出的错误带上应答 `error`（不进 `message`）；`host-tool-align.ts` 的 `register` 恰好相等时抛 `HttpError("kb_tool_conflict")`。

## 3. 真实 omp 与文档

- [ ] 3.1 翻转 `server/test/omp-official-host-tools.test.ts` 的三个同名用例（标题里的 `#2011 current state` 换成新行为）：有库 → 两条 prompt 都 409 `kb_tool_conflict`；
  没有库、知识库关闭 → `approval.request{tool:"kb_search"}`、自动拒绝后项目工具 `execute` 没运行（上游 tool 消息是 `Tool call denied by user: kb_search`，不是项目工具的哨兵）。
  跑 `env -u RAGFLOW_BASE_URL -u RAGFLOW_API_KEY_FILE WORKBUDDY_OMP_TEST=1 OMP_BIN="$PWD/var/omp/omp" npm run test:focus --workspace server -- omp-official-host-tools`。
- [ ] 3.2 文档：`knowledge-base.md` 审批放行段改为新规则（放行前提、冲突码）；残余句不删，改写为「已收紧为须经所有者审批（#2011）；批准之后项目工具的输出仍以 `kb_search` 步骤与检索卡展示（`details.bases` 合法时还成为 `kb.hits`），
  已注册之后才加载的同名项目工具 [INFERENCE] 未实测」两条残余；实测记录 §2.10 末尾补一段宿主处理的变化（不改实测事实本身）；`openspec/glossary.md:106`「放行」加上「这一代进程注册过 `kb_search`」。
- [ ] 3.2b 功能验收清单：`docs/acceptance/functional-checklist.md` 加两行（`待签`）——工作空间有同名项目工具且有库时，发送显示 `kb_tool_conflict` 的文案；
  知识库关闭（或没有库）时 `write` 档出现 `kb_search` 确认卡。格式由 `web/test/functional-checklist.test.ts` 守卫。
- [ ] 3.3 `npm run test:focus --workspace server -- host-tool`、`-- approval`、全部官方门控 `-- omp-official-`、`npm test --workspace server`、`make check` 通过（日志带 `EXIT=`）。
