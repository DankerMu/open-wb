## 1. 过滤运行命令

- [x] 1.1 `server/package.json` 与 `web/package.json` 的 `scripts` 各加 `"test:focus": "vitest run"`；`test` 脚本逐字不变。
- [x] 1.2 `AGENTS.md` Agent Operating Rules 的「范围化验证」一条补写过滤形式 `npm run test:focus --workspace <ws> -- <pattern>`（所选测试通过即退出 0），并注明覆盖率门禁只由全量 `npm test --workspace <ws>` / `make test` 承担。
- [x] 1.3 `openspec/project-profile.md` Command entry points 加 `server-test-focus` / `web-test-focus` 两项，Verification matrix 加同一行。

Must preserve（下游消费者）：
- `Makefile:29` `make test` → `npm test --workspaces`，四项 80% 全局阈值。
- CI `unit-tests`（`npm test --workspace server`）与 `unit-tests-web`（`npm test --workspace web`）两个 job，其步骤序列由 `scripts/test-ci-harness.sh` oracle 钉住。
- AGENTS.md Verification Matrix 表与 Makefile `.PHONY` / 页头，由同一 oracle 逐字钉住。

Non-goals：
- 不往 AGENTS.md Verification Matrix 表加行；不加 Makefile 目标；不加 `constraints.yaml` `verification.surfaces` 条目。
- 不改 `vitest.shared.mjs` 阈值；不改已归档 change 的文本。

验证：
- `npm run test:focus --workspace server -- mounts-validate` → 退出码 0，不报覆盖率阈值。
- `npm run test:focus --workspace web -- api-commands` → 退出码 0（`web/test/api-commands.test.ts`）。
- 临时在 `server/test/mounts-validate.test.ts` 与 `web/test/api-commands.test.ts` 各让一条断言失败（不提交）→ 两条过滤命令各自退出非 0；还原。
- `npm test --workspace server -- mounts-validate` 仍退出 1 且报覆盖率阈值。
- `git diff origin/master -- server/package.json web/package.json` 只多 `test:focus` 一行（各一处），两个 `test` 脚本逐字不变。
- `make check` 退出码 0；`make test-guardrails` 全 PASS。

## Risk packs

- Public API / CLI / script entry — selected：新增两个 workspace 脚本；由上面的通过/失败退出码验证钉住。
- Config / project setup — selected：`test` 脚本与阈值不变；由 `npm test ... -- <pattern>` 仍退出 1 的对照与 package.json diff 验证；边界见 Non-goals。
- Documentation / migration notes — selected：AGENTS.md 与 project-profile.md 两处写同一形式（1.2、1.3）；`make test-guardrails` 验证 AGENTS.md 未触发 oracle。
- 其余 pack — not selected：无运行时代码、无文件 IO、无并发。
