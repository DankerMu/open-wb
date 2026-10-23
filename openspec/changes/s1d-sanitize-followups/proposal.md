# Proposal: s1d-sanitize-followups

## Why

s1d 后续审查又立了两条 issue，owner 2026-10-23 要求「只解决立 issue 的问题，然后准备本 epic 验收」：

- #1716：`core/upstream-failure.ts` 的 `dropSecretHead` 对每个密钥的每个真前缀都对整个密钥集跑一次 `replaceSecrets`，代价约 Σ|s|² × n。密钥集是全部已登记上游的并集，路径段 ≥ 8 的各成一条，所以管理员登记一条路径段多的长地址（或十来条普通地址）之后，任一上游 ≥500 且正文被截断（16 KiB、5 s、出错、提前关闭）时，主事件循环被同步卡住数秒到上百秒（16 KB 单地址实测 103 s），全体用户一起停摆。
- #1718：`web/test/center-models-form.test.tsx:179` 的焦点断言在 `settled()`（`vi.waitFor`，不经 RTL `asyncWrapper` 与 #1541 屏障）之后同步读 `document.activeElement`，Radix FocusScope 卸载回焦的 `setTimeout(0)` 在负载下晚于它，偶发读到 `body`。

## What Changes

- `dropSecretHead` 保持现有比较语义与次序，加精确的必要条件剪枝（替换形状的末码元只能是前缀末码元或 `]`，文本末码元二者都不是时跳过），只在替换链里保留可能命中的密钥，并给整次计算一个固定预算（按朴素搜索比较次数的上界计费，与模式结构无关）；超出预算即 fail closed：整段节选为空（代理回 `模型服务返回 HTTP <status>`，探活为 `HTTP <status>：`），绝不留下半截尾巴。
- center-models 用例：`:179` 改为等焦点本身（RTL `waitFor`），`settled()` 内部改用 RTL `waitFor`。

## Impact

- 规格：upstream-failure 新增「截断尾部丢弃的计算上界」；model-proxy 修改「透传端点与 bearer 鉴权」，节选定义补「超预算时为空」。预算内的行为逐字不变。
- 代码：`server/src/core/upstream-failure.ts`；`web/test/center-models-form.test.tsx`、`web/test/center-models-support.tsx`；用例若干。
- 不动：`sanitizeUpstreamText` / `redact`（`app.ts:382` 会话侧只走它）、密钥集组成（`upstreamSecretList`）、地址规则。
