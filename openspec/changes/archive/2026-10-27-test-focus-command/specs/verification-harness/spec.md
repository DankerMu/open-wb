## ADDED Requirements

### Requirement: 过滤测试运行命令

server 与 web 两个 workspace SHALL 各提供 `test:focus` 脚本，内容为 `vitest run`（不带 `--coverage`），过滤运行的文档化形式为 `npm run test:focus --workspace <ws> -- <pattern>`：所选测试全部通过即退出码 0，任一失败即非 0。`test` 脚本 SHALL 保持 `vitest run --coverage`，全量 `npm test --workspace <ws>` 与 `make test` 的四项 80% 全局覆盖率阈值不变。`AGENTS.md`「范围化验证」规则与 `openspec/project-profile.md` 命令面 SHALL 记录这一过滤形式（AGENTS.md 的 Verification Matrix 表只列 Makefile 目标，不收这一行），并写明覆盖率门禁只由全量运行承担。

#### Scenario: 过滤运行只看所选测试的结果

- **WHEN** 执行 `npm run test:focus --workspace server -- mounts-validate`，所选测试全部通过
- **THEN** 退出码为 0，不报覆盖率阈值
- **AND** 所选测试中有一条失败时退出码非 0
- **AND** 执行 `npm test --workspace server -- mounts-validate` 仍因全局覆盖率阈值退出非 0
