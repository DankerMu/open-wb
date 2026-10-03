# Tasks: smoke-live-multiline（#755）

Fixture level: compact

## 1. 实现
- [ ] 1.1 `Makefile`：`smoke-live` 配方的 `content_pattern` 改为 `(?s)^.+$$`，其余字节不变。
- [ ] 1.2 `scripts/test-ci-harness.sh`：Make oracle 里 `smoke-live` 配方的期望行同步；凡以该配方原文为锚点的 mutation（`cm`）用例一并更新；新增一条 mutation：把配方改回 `^.+$$` 时 oracle 拒绝。
- [ ] 1.3 不改其它被跟踪文件。

## Must preserve
- `make smoke` 配方逐字节不变；`.PHONY` 与目标头不变；`make test-guardrails` 全绿（PASS 数只因新增 mutation 而增）。
- 缺变量先失败、不打印值、不调用 hurl 的门禁行为不变。

## Required evidence
- E1 `make test-guardrails` exit 0，报告 PASS 数（基线 816）。
- E2 hurl 对照（本地静态响应，无需真实端点）：多行内容下 `^.+$` exit 4、`(?s)^.+$` exit 0；空字符串内容下 `(?s)^.+$` 仍失败。
- E3 `make smoke-live` 缺变量时仍先失败（两个变量各一次，无 hurl 调用）。
- E4（编排方执行）真实端点上完整 `make smoke-live` exit 0，回复为多行。
- E5 `make lint`、`make check` 或等价 gates、`openspec validate smoke-live-multiline --strict --no-interactive` exit 0。

## Negative controls
- N1 Makefile 改回 `^.+$$` → `make test-guardrails` 失败于 smoke-live 配方 oracle。
- N2 只改 oracle 不改 Makefile → 同样失败。

## Risk packs
| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | Make 目标配方变更 → E1、E3、E4 |
| Config / project setup | yes | oracle 与配方必须同步 → N1、N2 |
| 其它 | no | 无运行时代码 |
