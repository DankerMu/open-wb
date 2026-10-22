# Design: s1d-registry-followups

## Context

- `server/src/models/store.ts:57,63-65`：`USERINFO = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/?#]*@/u`，`viewBaseUrl` 只做这一个替换；`store.ts:143-148` 的沿用分支以 `upstream.baseUrl === viewBaseUrl(current.baseUrl)` 判定。
- `server/src/core/upstream-failure.ts:179-201` `baseUrlParts`（userinfo 正则在 :184）：同形正则取 userinfo，之后 `new URL` 取路径与查询。
- env 种子不过地址规则：`server/src/agent-config.ts` 只拒空值，`startup-registry.ts:53-54` → `store.seedIfEmpty` 原样入表。
- 探活拼接 `server/src/models/probe.ts:87`：`${baseUrl.replace(/\/+$/u, "")}/models`。
- 代理拼接 `server/src/model-proxy/index.ts:571-574` `joinChatCompletions`：补 `/` 后 `new URL("chat/completions", root)`；带查询串时 `/` 落进查询串。
- 发布失败接线 `server/src/server.ts:492-500` `onPublishFailed: writeRecord`；编译入口用例 `server/test/models-rest-restart.test.ts` 只走 201 成功路径。

## Decisions

- **D1 单一 helper**：`core/base-url.ts` 是唯一实现，`models/` 与 `model-proxy/` 都经 core 引用（不互相导入，system.md 依赖规则）。
- **D2 视图形式**：`withoutUserinfo(s)`：`new URL(s)` 成功且 `username` 或 `password` 非空 → 清空两者后返回 `href`；成功但无 userinfo → 返回既有正则替换的结果（authority 内没有 `@` 时即原样，不做规范化；`https://@host/v1` 这类空 userinfo 仍去掉 `@`）；解析抛错 → 退回正则替换。兜底正则容忍前导空白与 `:` 后任意个 `/` 或 `\`（`^\s*([A-Za-z][A-Za-z0-9+.-]*:[\/\\]*)([^\/?#]*)@`；userinfo 段沿用 master 的 `[^/?#]*`，**允许 `\`**——`DOMAIN\user:p@h`、密码里未编码的 `\` 在 master 上也被去掉，不得回退），使 WHATWG 解析不了的非规范种子地址（如 ` https://u:p@h:abc/v1`、`https:\u:p@ho st/v1`）也去掉 userinfo；`userinfoParts` 用同一正则。纯函数。
- **D3 净化部件**：`userinfoParts(s)` 返回正则取到的原文 userinfo 与其密码段，并上 `new URL` 一侧的「userinfo 整串」（`password === "" ? username : `${username}:${password}``）与 `password`，以及二者的 `decodeURIComponent` 形式（解码失败则略），去重去空；URL 一侧的整串只在 `password` 非空、或正则未取到 userinfo 时加入（`https://admin:@h` 的空密码不把 `admin` 单列，正则原文 `admin:` 已在列表里）。**不单列 `username`**：短用户名（`u`、`admin`）会把正常报错文本削碎（与 `upstream-failure.ts:15` 不单列短路径段同理；`model-proxy-failures.test.ts:110,118` 的 `Authorization` 会被打成 `A[已移除]thorization`）。集合语义与 upstream-failure 规格「userinfo 原串与其中的密码段」一致，只是取法补上 WHATWG 解析，所以该规格不改。`baseUrlParts` 用它替换内联正则。
- **D4 拼接**：`upstreamEndpoint(s, sub)`：`u = new URL(s)`；`u.pathname = u.pathname.replace(/\/+$/u, "") + "/" + sub`；`u.hash = ""`；返回 `u`。查询串保留；userinfo 原样保留在 URL 上（与现状一致：Node `http(s).request` 在显式 `authorization` 头存在时不另发 Basic）。探活 `sub = "models"`，代理 `sub = "chat/completions"`。
- **D5 不禁止 `?`**：REST 地址规则不变。

## Risks / Trade-offs

- 代理拼接改为 URL 语义：对 `…/v1`、`…/v1/`、`http://h`（无路径）三类与改动前逐字相同（用例逐条钉住）；带查询串的 base URL、路径以多个斜杠结尾（`…/v1//` 由 `/v1//chat/completions` 变为 `/v1/chat/completions`，与探活一致）、空查询（`…/v1?` 由丢掉 `v1` 变为保留）行为改变，都是从错变对。
- `withoutUserinfo` 对带 userinfo 的地址返回 WHATWG 规范化后的 `href`（如前导空格去掉、`http:/` 补成 `http://`）。沿用分支的往返判据以同一函数计算，客户端送回视图形式即命中。

## Sketch seams under test

- `server/test/core-base-url.test.ts`（新）：三函数的表驱动用例。
- `models-rest.test.ts`：四种非规范种子地址的视图与沿用往返（store 层沿用分支经 REST 端到端覆盖：`routeOf` 逐字不变）。
- `models-probe.test.ts`：带查询串的 base URL 打到 `/v1/models?org=a`。
- 代理用例：带查询串的 base URL 打到 `/v1/chat/completions?org=a`；三类既有形状不变。
- `models-rest-restart.test.ts`：编译入口发布失败。
