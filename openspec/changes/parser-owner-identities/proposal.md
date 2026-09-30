# Proposal: parser-owner-identities（#512）

## Why
父 change `s1c-session-metadata-presentation` tasks 1.3（epic #509，design D2「`http/errors.ts`」）。会话元数据 REST（4.1 `POST /api/sessions` 可选 body、4.2 `PATCH /api/sessions/:id`）需要共享错误映射器把它们的 content-parser 错误映射为 400；现行 `server/src/http/errors.ts` 的归属集是 URL 字符串集合并带 POST-only 门（`routeOwnerResult` :69-83），无法表达 `PATCH /api/sessions/:id`，且去掉 POST 门后按 URL 判定会让同路径 `DELETE /api/sessions/:id` 被顺带覆盖。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded
Blast radius: 全站 content-parser 错误的对外映射（登录/登出/prompt/代理/工作空间/回合控制十条既有身份）；判定改错会让既有归属路由 400 退化为 500，或让非归属方法/路由把 500 误报为 400。合入即时行为：已注册的 `POST /api/sessions`（`server/src/sessions/rest.ts`，无 `bodyLimit`）malformed body 由 generic 500 变为 400（预期）。
Selected risk packs: Public API / CLI / script entry（对外错误合同）；Legacy compatibility / examples（十条既有身份、404 恢复与 generic 500 语义不变）；Error handling / rollback / partial outputs（伪造错误不映射、非归属方法保持 500）；Schema / columns / units / field names（错误码表仍十三码）
Evidence floor: 新建 `server/test/http-parser-owners.test.ts`（`handleHttpError` + `requestShaped` 接缝）覆盖 design「Required evidence」；`auth-request-errors.test.ts` 零改动全绿；`http-typed-errors.test.ts` 仅删除一条已过时的守卫条目（并允许把其 describe 标题「恰十条身份」改为「恰十二条身份」）；`npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0。

## What Changes
- `server/src/http/errors.ts`：`CONTENT_PARSER_OWNED_ROUTES` 改为 `"<METHOD> <route template>"` 身份字符串集合（十二条），`routeOwnerResult` 以 `` `${request.method} ${routeOptions.url}` `` 精确命中判定、去掉 POST-only 门；注释同步。
- 新建 `server/test/http-parser-owners.test.ts`。
- `server/test/http-typed-errors.test.ts`：从 `NON_OWNER_CASES` 删除 `["POST", "/api/sessions"]` 一条（该守卫断言的是本 change 有意改变的旧行为）。偏离 issue「既有测试零改动」（issue 只点名 `auth-request-errors.test.ts`），PR 偏离记录写明。

## Capabilities
- MODIFIED `http-service-skeleton`「统一错误信封」：以当前主 spec（A 的十条已并入）为底，只并入父 delta 中 1.3 的部分——归属判定句（method 与 matched route 合起来恰为十二条、PATCH 以 PATCH 归属）与三个 Scenario 中「十 → 十二」「非本身份方法（含 `DELETE /api/sessions/:id`）保持 generic 500」「按 method + route 十二身份集判定」的措辞。父 delta 的「`POST /api/sessions` 是可选 body 的归属路由…/`PATCH` owner 预检…/`DELETE` 不读 body…」段与 Scenario「会话元数据 parser owner 的真实 HTTP 边界」属 4.1/4.2/4.3b，留给它们；父 delta 在 stop/fork Scenario 中落后于主 spec 的两处措辞（`malformed, empty or unsupported-media inputs`、`normal behaviour`）保持主 spec 文本；父 delta 归档前须以已归档主 spec 为底 rebase 该 Requirement，否则会回退这两处。Scenario「产品路由身份在共享映射器中的归属」中的 PATCH/DELETE `/api/sessions/:id` 在本刀只由映射器接缝证明：4.2/4.3b 注册路由前，真实 PATCH/DELETE 请求命中 `/api/*` catch-all 返回 404。

## Impact
- 仅 `server/src/http/errors.ts` 与测试；不挂载产品路由，不触碰 `server/src/sessions/**`、`core/errors`、web。

## Non-goals
- `POST /api/sessions` 的 `bodyLimit` 与 body 校验（4.1）；`PATCH` 路由注册（4.2）；`DELETE` 路由（4.3b）；错误码与文案。
