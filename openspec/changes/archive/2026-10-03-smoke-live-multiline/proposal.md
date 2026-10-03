# Proposal: smoke-live-multiline（#755）

## Why
`make smoke-live` 传给 hurl 的 `content_pattern=^.+$` 中 `.` 不匹配换行（Rust regex）。真实模型的回复多数带换行，`smoke/chat.hurl:70` 的 `content` 断言因此必然失败，回合本身已 `done`。`make smoke` 用假上游的单行固定回复，所以一直没暴露（#544 取证时发现）。

## What Changes
- `Makefile` `smoke-live` 配方：`content_pattern=^.+$$` → `content_pattern=(?s)^.+$$`。
- `scripts/test-ci-harness.sh` 的 Make oracle：`smoke-live` 配方期望值同步；现有针对该配方的 mutation 用例随之更新。
- 规格：chat-harness MODIFIED「手动真实上游冒烟入口」——配方里的变量值与一个新 Scenario。

## Non-goals
- `make smoke` 的精确正则不动；`smoke/chat.hurl` 不动；AGENTS.md Verification Matrix 的口径（非空 done 回复）不变。

## Impact
- 只影响手动入口 `make smoke-live`；CI 不跑它。
