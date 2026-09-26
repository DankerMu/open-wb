# Proposal: error-codes-turn-control（#450）

## Why
父 change `s1c-turn-control-governance` tasks 1.2（epic #448）。进程池全忙需要 503 `agent_capacity`，审批重复作答需要 409 `approval_settled`；四条新回合控制路由（stop/regenerate/fork/approvals）须先进入共享映射器的 content-parser 归属集，其后路由切片（5.1a/5.1b/5.2a/5.2b）才能得到 exact 400 而非 generic 5xx。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree: 公共错误码表与 content-parser 归属集属 public API 契约)
Blast radius: 全部 `/api/*` 错误信封；若映射按状态码而非 code 区分，三种 409 会互相伪装；若归属集判定放宽，普通 programmer error 会被误标为 400。
Selected risk packs: Public API / CLI / script entry；Schema / columns / units / field names（错误信封 code/message 字段）；Error handling / rollback / partial outputs（意外错误不伪装）；Legacy compatibility / examples（既有十一码与六条归属不变）
Evidence floor: 新建 server vitest 测试文件断言十三码 status/message、两新码信封、伪造对象仍 generic 5xx、十条身份逐一 400 且非 POST/lookalike/raw-concrete 仍 generic 500、两新码经 no-store 路由保持 no-store；正向断言先红后绿（负向守卫始终为绿）；既有测试只改 `auth-lifecycle.test.ts` 穷尽守卫表；`npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift` 退出 0。

## What Changes
- `server/src/core/errors/index.ts`：typed definition map 十一码 → 十三码（`agent_capacity` 503 `Agent 容量已满，请稍后重试`、`approval_settled` 409 `该审批已处理`）。
- `server/src/http/errors.ts`：状态映射同步；`CONTENT_PARSER_OWNED_ROUTES` 六 → 十（`POST /api/sessions/:id/stop`、`/regenerate`、`/fork`、`/approvals/:approvalId`）；注释同步。
- 新建测试文件（server vitest）。

## Capabilities
- MODIFIED `http-service-skeleton`「统一错误信封」：取父 delta，去掉 bodyless stop/regenerate 规则句与两个路由级 Scenario（「回合控制 parser owner 的真实 HTTP 边界」「bodyless 归属路由拒绝任何 body」），二者归 5.1a/5.1b/5.2a/5.2b。
- ADDED `omp-pool`「agent_capacity 错误码」：整段取父 delta（全量交付）。
- 不含 `tool-approval`「审批作答 REST」：`approval_settled` 的码定义已在「统一错误信封」码表中；该 requirement 其余为作答路由行为，归 5.2a #468。

## Impact
- 两个源文件 + 一个新测试文件；不触碰 `server/src/sessions/**`。四条路由尚未注册，归属集成员对运行时无影响直到路由出现（集合成员断言，非死代码：集合被 mapper 读取）。

## Non-goals
- 四条新路由的注册与其真实 HTTP parser-owner 用例；抛出新码的调用方（4.1/4.3）；web 文案透出（7.1）。
