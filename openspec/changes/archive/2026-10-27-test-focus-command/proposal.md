## Why

`npm test --workspace <ws> -- <pattern>` 恒以退出码 1 结束：`test` 脚本固定带 `--coverage`，而 `vitest.shared.mjs:9` 的 80% 阈值是全局的，过滤后只执行少数源文件，阈值必然不过（#1768 实测 lines 1.1%）。凡把这条写法列为必过验证的验收标准都字面不可满足，证据只能来自别的命令，评审无法按字面复现。

## What Changes

- `server/package.json` 与 `web/package.json` 各加 `"test:focus": "vitest run"`（不带 `--coverage`）；`test` 脚本保持 `vitest run --coverage`，`make test` / CI 的全量覆盖率门禁不变。
- `AGENTS.md` Agent Operating Rules 的「范围化验证」一条与 `openspec/project-profile.md` 命令面写明过滤形式 `npm run test:focus --workspace <ws> -- <pattern>`，并注明 `npm test` 只用于全量。不写进 AGENTS.md 的 Verification Matrix 表：该表每行须解析到 Makefile 目标（AGENTS.md:96），且整段被 `scripts/test-ci-harness.sh` 的 `contract AGENTS matrix wrap *` 用例当作唯一锚点逐字钉住。
- verification-harness「共享 Vitest 配置的 native ESM 边界」里「workspace test scripts SHALL 保持不变」按字面指既有 `test` 脚本；本 change 只新增 `test:focus`，`test` 逐字不变，不构成冲突。
- Owner 裁定（2026-10-26，#1768 评论）：取推荐方案。s1b change 已归档、子 issue 已关闭，issue 里迁移 tasks.md 与子 issue「验证：」行的条目没有对象，不做；归档文本不改（issue 边界）。

## Triage

```text
Issue type: refactor (tooling)
Fixture level: compact
Upstream suggested level: absent
Blast radius: workspace 脚本入口；若误改 `test` 脚本，全量覆盖率门禁失效；AGENTS.md 受 test-ci-harness oracle 钉住
Selected risk packs: Public API / CLI / script entry; Config / project setup; Documentation / migration notes
Evidence floor: 两个 workspace 过滤命令通过/失败两种退出码实测；`npm test --workspace <ws>` 仍执行 80% 阈值；`make check` 与 `make test-guardrails` 全绿
```

`design.md` 省略：compact 级，无设计取舍。

## Impact

- `server/package.json`、`web/package.json`、`AGENTS.md`、`openspec/project-profile.md`。
