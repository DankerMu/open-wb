# Proposal: api-sessions-split（#471）

## Why
父 change `s1c-turn-control-governance` tasks 7.0a（epic #448）。`web/src/lib/api.ts` 749 行，距 size-guard 800 行硬限无余量；7.1 的四个回合控制方法（stop/regenerate/fork/approvals）无处落。父 design「模块拆分（size-guard）」规定首刀做纯搬迁、行为不变的拆分，落点为 `lib/api-sessions.ts`（会话族方法）。

## Triage
Issue type: refactor
Fixture level: expanded
Upstream suggested level: expanded (agree: `ApiClient` 是 web 全部页面共用的入口，7.1 在此落点改跨端严格解析契约；本刀须证明公开面与错误/401 行为逐字不变)
Blast radius: 全部 web 页面的 API 调用——注入的传输若换了实现、`onUnauthorized` 未按原引用传递或属性被覆盖，会话页/401 登出/错误文案会静默回归。
Selected risk packs: Legacy compatibility / examples（`ApiClient` 公开面与 19 个既有导入方（11 源文件 + 8 测试文件）不变）；Error handling / rollback / partial outputs（错误信封、request_failed 与 401 通知不变）
Evidence floor: `git diff --stat -- web/test` 为空且 web 测试总数与 master 相同（53 文件 / 1017 例）全绿；`bash scripts/size-guard.sh` 0 且 `api.ts` ≤ 700 行；`make lint`、`make typecheck`、`make anti-drift`（knip 零新增）、`npm run build --workspace web` 0。

## What Changes
- 新建 `web/src/lib/api-sessions.ts`：逐字搬入 `createApiClient` 返回对象中的 `listSessions`/`createSession`/`getMessages`/`prompt` 四个方法体与仅被它们使用的 `sessionEndpoint`，包在唯一导出的工厂 `createSessionMethods(onUnauthorized, transport)` 中；`api.ts` 的私有传输辅助（`request`/`requestOptions`/`getRequestOptions`/`requestFailed`）由 `api.ts` 以参数注入。
- `api.ts`：删去上述块，在返回对象**首位**展开 `...createSessionMethods(onUnauthorized, {…})`；`session-contract.js` 的导入改为只剩四个类型（值解析器随方法迁走）；新增一行 `import { createSessionMethods } from "./api-sessions.js"`。`ApiClient` 类型声明与 `api.ts` 的导出集合逐字不变。
- 不新增、不改动任何测试（纯搬迁，行为不变的证明是既有 web 测试原样通过）。

偏离/澄清（相对 issue 正文）：
1. issue 写「会话族方法及其 DTO 解析」——会话 DTO 解析（`parseSession`/`parseSessionList`/`parseMessageSnapshot`/`parsePromptAccepted`）早已在 `web/src/lib/session-contract.ts`，`api.ts` 内没有可搬的会话 DTO 解析；本刀只搬方法体与 `sessionEndpoint`，`session-contract.ts` 零改动。
2. 工厂外壳与 `SessionTransport` 参数类型（约 20 行）是新增胶水而非搬迁块：四个方法是闭包捕获 `onUnauthorized` 的对象字面量成员，调用 `api.ts` 的模块私有传输辅助；若从 `api.js` 值导入这些辅助，要么形成 `api.ts ↔ api-sessions.ts` 值环，要么须给 `api.ts` 新增导出（违反 issue「导出面不变」）；另拆第三个传输文件则越出 PR Boundary（仅 `api.ts` 与 `api-sessions.ts`）。注入是满足三者的最小做法。`createSessionMethods` 是新的模块级函数兼新导出，属上述已记录胶水：验收「diff 中不出现新方法」的「新方法」指 `ApiClient` 实例方法（与 issue Out of Scope「任何新方法、新状态枚举…（7.1 起）」一致）；issue「新模块不新增对外导出」以 knip 零新增检验——拆出的模块被 `api.ts` 引用，必然有导出。

## Capabilities
- ADDED `chat-web`「API 客户端源码模块划分」：记录 size-guard 落点、模块长期职责（含 7.1 回合控制方法的落点）与依赖方向（父 delta 无对应 requirement；依据父 design「模块拆分（size-guard）」，与 #452/#454 先例同形）。

## Impact
- 仅 `web/src/lib/api.ts` 与新建 `web/src/lib/api-sessions.ts`；不触碰 `web/test/**`、`web/src/features/**`、`web/src/lib/session-contract.ts`、server、Makefile、CI。

## Non-goals
- 任何新方法、新状态枚举、新错误码处理（7.1 起）；`page.tsx` → `turn-actions.ts` 搬迁（7.0b）；`ApiClient` 类型声明重构（如改成交叉类型）；传输层另拆文件；size-guard 阈值调整。
