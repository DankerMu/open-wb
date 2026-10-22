# Proposal: s1d-registry-followups

## Why

s1d-model-registry（Epic #1640）合并后，审查留下三条范围外问题，owner 2026-10-22 要求立 issue 并处理：

- #1712：模型视图去 userinfo 只认字面 `scheme://`。env 种子地址不做 URL 校验，WHATWG 可解析的非规范写法（`http:/u:pw@…`、`http:u:pw@…`、`https:\u:pw@…`、前导空格）会把上游密码回显给所有管理员；`core/upstream-failure.ts` 的净化密钥集用同一种正则，这几种写法下密码段不进密钥集。
- #1711：生产入口「发布失败时 stderr 恰一行 `{"event":"model_publish_failed"}`」没有编译入口级证明，删掉 `server.ts` 的 `onPublishFailed: writeRecord` 仍全绿。
- #1710：base URL 允许查询串，但探活把 `/models` 拼进查询串、代理的 `new URL("chat/completions", root)` 丢掉末段与查询串，两处都打不到目标端点且互不一致。

## What Changes

- 新 `server/src/core/base-url.ts`：`withoutUserinfo(baseUrl)`（视图形式）、`userinfoParts(baseUrl)`（净化用）、`upstreamEndpoint(baseUrl, path)`（拼接）。三者先按 WHATWG `new URL` 解析，解析失败退回兜底正则（容忍前导空白与 `:` 后的 `/`、`\`）；只在确有 userinfo 时改写视图形式，其余原样返回（保持 `store.update` 视图往返相等的判据）。
- `models/store.ts` 的 `viewBaseUrl`、`core/upstream-failure.ts` 的 `baseUrlParts` 改用它们。
- 探活与代理都用 `upstreamEndpoint`：路径去掉结尾斜杠后接子路径，查询串保留（owner 2026-10-22 选「按 URL 语义拼接」，不禁止 `?`——规格已允许查询串，禁止会破坏既有配置）。
- 编译入口用例补「发布失败 → 非信封 500 + stderr 恰一行」。

## Impact

- 规格：model-registry 新增「上游地址的视图形式与拼接」、修改「探活」的拼接措辞；model-proxy 新增「上游端点拼接」。
- 代码：`server/src/core/base-url.ts`（新）、`server/src/models/{store,probe}.ts`、`server/src/core/upstream-failure.ts`、`server/src/model-proxy/index.ts`；用例若干。
- 对既有常见形状行为不变（`…/v1`、`…/v1/`、无路径、`…/`与改动前逐字相同）；带查询串、多个结尾斜杠、空查询三类从错变对（design Risks）。
