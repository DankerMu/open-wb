## ADDED Requirements

### Requirement: 第三方 CI action 使用 Node 24 runtime
CI SHALL 只以 `actions/checkout@v5`、`actions/setup-node@v5`、`astral-sh/setup-uv@v7` 与 `gitleaks/gitleaks-action@v3` 使用这四种第三方 action；其对应 major tag 的 `action.yml` SHALL 声明 `runs.using: node24`，且 GitHub-hosted runner SHALL 满足 Node 24 action 所需的 runner v2.327.1+。七个 direct jobs 的使用矩阵 SHALL 完整且唯一：checkout 分别出现在 fast-checks、unit-tests、anti-drift、secret-scan、sast、smoke、ui-walk；setup-node 分别出现在 fast-checks、unit-tests、anti-drift、smoke、ui-walk；setup-uv 只出现在 fast-checks 与 unit-tests；gitleaks-action 只出现在 secret-scan。不得保留旧/混合 major、Node 20 fallback environment、重复/替换/旁路 action 或未受约束的同类使用点。

关键输入与顺序 SHALL 保持：每个 checkout 在所属 job 的仓库消费者前执行；五个 setup-node 均保留 exact `{ node-version-file: .tool-versions, cache: npm }` 并在 `npm ci` 前完成，只缓存 npm package-manager data 而非 `node_modules`；两个 setup-uv 在 `uv sync` / `uv run` 前安装 uv并保持 GitHub-hosted cache lookup/restore 与成功 post lifecycle，按 cache hit/miss 允许 no-save/save 分支；secret-scan 的 checkout 保留 exact `fetch-depth: 0`，随后 gitleaks-action 只以 exact `GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}` 环境运行。所有原有 run steps、job timeout、constraints mirror、质量阈值、service harness、七项 aggregate dependencies及 failure/cancelled/skipped 拒绝语义 SHALL 保持不变。

source-derived CI oracle SHALL 从实际传入 workflow 解析全部七个 direct jobs，校验上述 action major/矩阵/输入/顺序和无 fallback/bypass 条件；任一旧 major、遗漏、混合、重复、替换、relocation、关键 input 漂移或 `ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION` 注入均 SHALL 使 `make test-guardrails` 非零。Mutation generator SHALL 绑定 scratch source，生成失败不得充当成功 rejection；不使用目标 action 的新增 unrelated job SHALL 继续可演进。

#### Scenario: 所有 direct jobs 在 Node 24 action 上完成
- **WHEN** 新 PR CI 在 GitHub-hosted `ubuntu-latest` 执行该 workflow
- **THEN** fast-checks、unit-tests、anti-drift、secret-scan、sast、smoke、ui-walk 与 `all-checks-passed` 均成功，所有 action post/cache steps 和原有下游 run steps实际执行
- **AND** setup-node 从 `.tool-versions` 使用 Node 24.13.1，main step 完成 npm cache lookup/restore（允许 primary-key hit 或 miss）且 post step 成功；primary-key miss 时 SHALL 保存新 cache，hit 时 SHALL 允许明确的 `not saving cache` 结果；setup-uv 安装可执行 uv并完成其 hosted cache lifecycle，secret-scan 在 full-history checkout 后成功执行 gitleaks

#### Scenario: Node 20 runtime annotation 完全消失
- **WHEN** 查询同一 PR head SHA 上七个 direct jobs 的全部 check-run annotations 与 action step logs
- **THEN** `Node.js 20 is deprecated` annotation 为零，四种 action均不被列为 Node 20 target，且 workflow/job/step environment 中不存在 `ACTIONS_ALLOW_USE_UNSECURE_NODE_VERSION`
- **AND** 项目 `.tool-versions` 的 Node 24 与 action自身的 `runs.using: node24` SHALL 作为两个独立证据记录，不得相互替代

#### Scenario: action major、输入与矩阵漂移 fail closed
- **WHEN** fixture 将任一使用点回退到旧 major、删除/重复/替换/搬移 action、形成新旧 major混合、改变 setup-node version/cache input、secret checkout depth、gitleaks token、setup顺序，或加入 Node 20 fallback/bypass metadata
- **THEN** source-derived oracle 非零，且每个 mutation 确实消费生成的 scratch workflow；baseline 和不使用目标 action 的 unrelated job 控制组仍通过

#### Scenario: 主版本兼容边界保持
- **WHEN** 比对四个候选 major 的 release notes、`action.yml` inputs/runtime 与本仓实际配置
- **THEN** checkout fetch/full-history、setup-node Node/npm cache、setup-uv install/cache 与 gitleaks token/扫描行为均有书面兼容性结论，runner 最低版本由 GitHub-hosted 环境满足
- **AND** 不升级更高 action major，不改变 action pin 策略、workflow permissions、secret 值、应用工具链版本、依赖/lockfile、产品代码、timeout、步骤或门禁阈值
