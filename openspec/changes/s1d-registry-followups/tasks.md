# Tasks: s1d-registry-followups

> 三个 issue 各一个 PR，按 1 → 2 → 3 串行；本 fixture 随第一个 PR 合入。owner 2026-10-22 要求处理；#1710 选「按 URL 语义拼接」。

## 风险包

| 风险包 | 选中 | 落点 |
|---|---|---|
| 凭证泄露（userinfo 密码进视图 / 净化遗漏） | 是 | 组 1 四种非规范地址的视图与净化部件用例 |
| 代理放行语义回归（转发目标变化） | 是 | 组 3 既有三类形状逐字不变 + 查询串用例 |
| 启动阶段与失败记录 | 是 | 组 2 编译入口发布失败用例 |

## 1. 视图形式与净化部件（#1712）

- [x] 1.1 核对 Context：`models/store.ts:57,63-65,143-148`、`core/upstream-failure.ts:179-201`（userinfo 正则在 :184；`userinfoParts` 结果须排在 base URL 原串之后、路径之前——`upstream-failure-sanitize.test.ts:134` 以 `toEqual` 比较整个列表）、`startup-registry.ts:53-54`、`agent-config.ts` 种子取值。
- [x] 1.2 测试先行：新 `server/test/core-base-url.test.ts`（`withoutUserinfo` / `userinfoParts` 表驱动：四种非规范写法（TS 字面值里反斜杠写 `"https:\\u:…"`）的视图分别为独立字面值 `http://gw.example/v1` / `https://gw.example/v1`、规范 `https://u:p@h/v1`、无 userinfo 原样返回、`https://@host/v1 → https://host/v1`、不可解析串走正则、百分号编码的密码段；`upstreamSecretList` 对 `http:/u:<哨兵>@…` 含哨兵且**不含单独的 `"u"`**）；`models-rest.test.ts` 加四种非规范种子地址：视图等于上述字面值、不含哨兵与 `u:`，以该字面值 `PUT` 只改名 → `routeOf` 读回逐字不变（不拿 GET 结果回送，避免同义反复）；`upstream-failure` 既有净化用例加一例（`http:/u:<哨兵>@…` 作 base URL，回显正文中哨兵被去掉）。
- [x] 1.3 新 `server/src/core/base-url.ts`（`withoutUserinfo`、`userinfoParts`；`upstreamEndpoint` 在组 3 加）；`store.ts` 的 `viewBaseUrl` 改为 `withoutUserinfo` 的再导出或直接替换调用处（删 `USERINFO`）；`upstream-failure.ts` 的 `baseUrlParts` 用 `userinfoParts` 替换内联正则。

Suggested fixture level: expanded - 凭证泄露（credentials）。

## 2. 发布失败的编译入口证明（#1711）

- [ ] 2.1 核对 Context：`server.ts:492-500`、`models-rest-restart.test.ts`（编译入口、同端口重启的写法与 stderr 采集）。
- [ ] 2.2 `models-rest-restart.test.ts`（或同目录新文件）加一例：编译入口启动后把 agent 目录（`OMP_STATE_DIR=<root>/state` → `home/.omp/agent`）换成普通文件（之后不再调 `files(root)`），管理员 `POST /api/models` → 500 非信封；`stderr` 以 `toBe('{"event":"model_publish_failed"}\n')` 断言（不用「含」）；`GET /api/models` 含该行（行保留；审计保留由停服后开库查表或省略，二选一写明）。变异：删掉 `server.ts` 的 `onPublishFailed: writeRecord` 后该例变红（跑过后还原）。

Suggested fixture level: compact - 只加用例。

## 3. 上游端点拼接（#1710）

- [ ] 3.1 核对 Context：`models/probe.ts:87`、`model-proxy/index.ts:571-574`、`fake-upstream.mjs` 的路径匹配（是否忽略查询串）。
- [ ] 3.2 测试先行（记录请求行用 `model-proxy-helpers.ts` 的 `startRecordingUpstream`，它记 `url`；`models-probe-helpers.ts` 的 `scriptedServer` 不记）：`core-base-url.test.ts` 加 spec「拼接保留查询串且既有形状不变」五例；`models-probe.test.ts` 加带查询串一例（测试内服务记录 `req.url` = `/v1/models?org=a`）；代理用例加带查询串一例（记录 `req.url` = `/v1/chat/completions?org=a`）并钉住 `…/v1`、`…/v1/`、无路径三类的转发路径与 `…/v1//` → `/v1/chat/completions`。
- [ ] 3.3 `core/base-url.ts` 加 `upstreamEndpoint`；`probe.ts` 与 `model-proxy/index.ts` 改用它（删 `joinChatCompletions`）。

Suggested fixture level: expanded - 代理转发目标。
