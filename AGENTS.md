# open-workbuddy — 工程操作契约

> eng-init 生成维护（L3 strict，见 `constraints.yaml`）。Claude 专属注记在 `CLAUDE.md`，领域术语在 `CONTEXT.md`。

## Code Canonicality

同一逻辑在仓库里只允许一个实现。版本演进属于 git 历史，不属于文件名或标识符。

- 新增函数/类/模块/文件前先 grep 现有实现：有相似的就扩展或重构它，确无才新建。
- 文件名、类名、函数名、模块名禁用后缀：`_v1` `_v2` `_new` `_old` `_backup` `_temp` `_copy` `_final` `_real` `_improved` `_refactored` `_fixed` `_legacy` `_deprecated`。已存在的视为待统一的债务，不是可效仿的模式。
- 原地重构：先提交工作状态，改原文件，跑测试；坏了 `git revert`。绝不"旧版留着以防万一"——git 就是安全网。
- 未经 `## Source of Truth & Refactor Contract` 书面例外，不得并行新旧实现过渡；原子替换。
- 注释掉的代码是 lint 错误不是安全网，删掉，git 记得。
- 无引用导出与死代码路径是债务：同一变更内接上或删除。
- 仓库不是草稿板：`tmp/`、`scratch/`、`backup/`、`_old/`、`deprecated/`、`archive/`、`wip/` 不得进提交。

### Enforcement

| 规则 | 执行点 |
|------|--------|
| 禁用后缀 / 草稿目录 / .bak | `scripts/naming-guard.sh`（pre-commit + CI） |
| 重复代码 ≤3% | jscpd（`.jscpd.json`，`make anti-drift` + CI） |
| 死代码 | knip（TS）+ ruff F401/F841（Py），`make anti-drift` + CI |
| Conventional commits | `.githooks/commit-msg` |

## Project Identity

内网部署的多用户 AI Agent Web 服务：对话 + 工作空间文件 + 专家/技能/连接器 + 内建知识库，账号级隔离（沙箱/权限/审计），全链路无公网依赖。多年期生产项目，代码几乎全由 AI agent 编写，约束档位 **L3 strict**（用户拍板，低于 agent 加成推荐的 L4，台账见 `constraints.yaml` downgrades）。行为基准 = `resource/workbuddy-live-demo.html`：demo 里能点出来的行为就是需求。

## Stack & Versions

| 组件 | 技术 | 版本锚 |
|---|---|---|
| server（app-server） | TypeScript + Node LTS | `.tool-versions`（nodejs 24.13.1） |
| web（浏览器 SPA） | TypeScript，P0 引入 React + Vite | 同上 |
| kbservice（知识库） | Python + uv | `kbservice/.python-version`（3.13） |
| agent 后端 | omp fork（另仓，冻结 v18.0.10） | `resource/backend-research.md` §2 |
| 工具 | Biome、Ruff、vitest、pytest、knip、jscpd | 根 `package.json` / `kbservice/pyproject.toml` |

依赖政策：新增依赖须在 PR 说明为什么现有工具做不到；主版本升级须人工评审。

## Directory Map

```
server/     app-server（业务后端：SSO/会话/工作空间/权限/沙箱/审计）
web/        浏览器 SPA（Playwright UI 走查在 web/e2e）
kbservice/  知识库服务（P2 起吸收 RAGFlow，Apache-2.0，义务见 ATTRIBUTION.md §3）
resource/   行为基准原型 + 后端选型研究 +（gitignore 的）上游参考克隆
app-reference/  上游应用只读副本（gitignore；仅 analysis/ 可写）
smoke/      Hurl HTTP 冒烟用例与深链 exact-byte fixture
scripts/    守卫脚本    .githooks/  git hooks    .github/    CI
```

### Module Boundaries

- **`app-reference/` 全树只读**（上游腾讯版权原始副本）：任何情况下不修改、不重打包、不"顺手修复"；唯一可写子树是 `app-reference/analysis/`。守卫机械拦截。
- server/web/kbservice 互不 import 源码；跨服务只走网络契约（HTTP/RPC）。
- 上游源码不复用，仅作架构与行为参照；唯一例外是设计 token（已标注来源）。

## Development Workflow

### 本地起步

```
make setup    # npm install + uv sync + 挂 git hooks
```

### 日常命令

| 动作 | 命令 |
|---|---|
| 全链验证（推送前必绿） | `make check` |
| lint + 格式 | `make lint`（修复用 `make fmt`） |
| 类型检查 | `make typecheck` |
| 测试 + 覆盖率门禁 | `make test` |
| 反漂移（死代码/重复/命名/行数） | `make anti-drift` |
| 守卫自证 | `make test-guardrails` |

## Verification Matrix

| Surface | Verify with | Command | Evidence required |
|---------|-------------|---------|-------------------|
| 静态面（lint/格式/复杂度） | Biome + Ruff | `make lint` | 退出码 0 |
| 类型面 | tsc --noEmit ×2 | `make typecheck` | 退出码 0 |
| 单元测试 + 覆盖率 | vitest + pytest | `make test` | 退出码 0 且覆盖率 ≥80% |
| 反漂移 | knip + jscpd + 守卫 | `make anti-drift` | 退出码 0 |
| 全链 | 以上全部 | `make check` | 退出码 0 |
| 守卫自身 | 注入违例自证 | `make test-guardrails` | 全 PASS |
| HTTP smoke | Hurl（调用方拥有已运行服务） | `make smoke` | 退出码 0；真实 HTTP 断言全绿 |
| UI 走查 | Playwright Chromium（调用方拥有已运行服务） | `make ui-walk` | 退出码 0；真实浏览器走查与 error oracle 全绿 |

每行命令必须解析到真实 Makefile 目标；无验证命令的 surface 的改动是 review-only，PR 必须写明。

## Important Development Notes

- **分析文档纪律**：路径基准写 `app-reference/app_asar/`；引用给真实行号；推断结论标 `[INFERENCE]`，不与直接证据混写。
- **归属义务**：根 LICENSE 为 Apache-2.0（只覆盖本仓自有内容）；上游版权 © 2026 Tencent；派生内容按 `ATTRIBUTION.md` 保留归属；吸收 RAGFlow 源码时其 §3 条件义务（LICENSE-RAGFlow/NOTICE/文件头）生效。
- demo 文件头的来源注释在编辑时必须保留。
- 文档路由：项目定位 `README.md`；建设方案与阶段账本 `PLAN.md`；**顶层架构基准 `docs/architecture/system.md`**（模块图/依赖规则/目录结构/数据流）；后端选型 `resource/backend-research.md`；上游结构分析 `app-reference/analysis/00-overview.md`（入口）；许可归属 `ATTRIBUTION.md`；长期架构决策 `docs/adr/`（难回退+无背景会困惑+真实权衡三者同立才写）。

## Conventions

- **TDD required（L3）**：新增生产文件先写失败测试再实现；配对测试文件缺失需在 PR 说明理由。mock 依赖，绝不 mock 被测系统。
- 命名遵循各语言惯例（TS camelCase / Py snake_case）；文件 ≤800 行、复杂度 ≤15、重复 ≤3%——阈值一律以 `constraints.yaml` 为准，改阈值先改那里。
- 提交格式 Conventional Commits（类型表见 `constraints.yaml`），agent 提交带 `Co-Authored-By`。
- 债务标记用 `TODO(#issue)`：无 issue 号的 TODO 不得进提交（评审拦截）。
- 偏离本文件任何约定时，PR 描述必须给出理由——无理由的偏离按缺陷处理。

## Code Review Self-Check

提交 PR 前自查：① `make check` 绿；② 新行为有配对测试；③ 无临时调试残留（console/print/skip）；④ 改动是否触碰 Critical Paths——是则在 PR 标注请求白盒审查；⑤ 文档随代码同步（PLAN/analysis/术语表）；⑥ 阈值/规则改动走 `constraints.yaml` 且说明理由。

## Critical Paths

改动以下路径必须人工审查实现（白盒），测试通过不豁免：

- **沙箱与文件边界**：路径越界拦截、白名单派生、挂载凭证存取（未来 `server/` 对应模块）。
- **omp 子进程治理**：spawn/回收、凭证注入（模型网关 token 与 kb 凭证不得进 omp 可读环境）、资源限额。

认证/会话与权限过滤/审计按用户决定走灰盒（合同+测试验收）——记录于 `constraints.yaml` downgrades；若出事故，此决定优先重议。

## Agent Operating Rules

- **允许**：本地跑全部验证；提交走 feature 分支 → PR → `all-checks-passed` 绿 → 合并（分支保护已启用；CI 仅在 pull_request 与 push:master 触发，纯分支推送不产生 check，故 PR 是唯一合入通路）。
- **禁止**：`--no-verify` 跳过 hooks；force-push 共享分支；对非本地环境做破坏性操作；未标注地修改 CI 文件；主版本依赖升级不经人工评审；把仓库当草稿板（会话临时文件放系统 scratchpad）。
- **证据要求**：成功声明须附本会话的新鲜命令输出（命令+退出码）。验证世界而非自述：重跑命令、外部重读文件、打真实端点；关键词探测自身输出不算证据。UI 声明需截图 + 零新增控制台报错。
- **范围化验证**：选覆盖改动面的最窄检查；改单模块跑该模块测试，全量交给 CI。覆盖率范围不得用 pass-with-no-tests 或收窄 include 掩盖未覆盖文件。
- **迭代闸门**：同一失败检查最多 3 轮修复循环，然后停下报告已试与所需；绝不削弱/跳过/删除测试换绿（skip 需关联 issue + 截止期）；每个绿点 checkpoint 提交。
- **CI 排障协议**：先分类失败层（fast-checks/unit-tests/anti-drift/secret-scan/sast）→ 读日志取第一个可行动错误 → 用同一命令本地复现 → 修根因 → 本地重跑该层再推送。环境差异记入 Important Development Notes。
- 并行 agent 各用独立 worktree；一任务一分支。

## Enforcement Index

严格度：**L3**（`constraints.yaml`）。级别：`advice` < `review-only` < `warn` < `block` < `gate`；低于 `warn` 的是人的承诺，不是机器检查。

| 规则 | 所在 | 检查点 | 级别 |
|------|------|--------|------|
| Lint/格式/复杂度（TS） | `biome.json` | `make lint` + CI | block |
| Lint/格式/复杂度（Py） | `kbservice/pyproject.toml` | `make lint` + CI | block |
| 类型严格 | `server/tsconfig.json`、`web/tsconfig.json` | `make typecheck` + CI | block |
| 覆盖率 ≥80% | `server/vitest.config.ts`、`web/vitest.config.ts`、`kbservice/pyproject.toml` | `make test` + CI | block |
| 文件 ≤800 行 | `constraints.yaml` → `scripts/size-guard.sh` | pre-commit + CI | block |
| 重复代码 ≤3% | `.jscpd.json` | `make anti-drift` + CI | block |
| 死代码 | `knip.json` + ruff | `make anti-drift` + CI | block |
| 禁用命名/草稿目录/.bak | `constraints.yaml` → `scripts/naming-guard.sh` | pre-commit + CI | block |
| app-reference 只读 | `constraints.yaml`（boundaries） → `scripts/naming-guard.sh` | pre-commit + CI | block |
| 密钥扫描 | gitleaks | CI（本机装有 gitleaks 时 pre-commit 亦 block） | block |
| SAST | semgrep（p/default） | CI | block |
| HTTP smoke | `.github/workflows/ci.yml`（job `smoke`） | `make smoke` + CI `smoke`/`all-checks-passed` | block |
| UI 走查 | `.github/workflows/ci.yml`（job `ui-walk`） | `make ui-walk` + CI `ui-walk`/`all-checks-passed` | block |
| Conventional commits | `.githooks/commit-msg` | pre-commit（commit-msg） | block |
| CI 聚合门禁 | `.github/workflows/ci.yml`（all-checks-passed） | CI | block |
| PR diff ≤400 行 | `constraints.yaml`（size_limits） | 评审检查项 | review-only |
| TDD 配对测试 | 本文件 Conventions | 评审 + 覆盖率代理 | review-only |
| 分支保护 | GitHub Ruleset `master-protection`（required status check = `all-checks-passed`；禁删除/禁 force-push） | GitHub 服务端 | gate |

阈值与正则的机器可读权威是 `constraints.yaml`；变更先改那里，再同步守卫脚本内的镜像正则。没有执行点的规则是愿望不是规则——要么接上，要么删掉。

### Known blind spots（交给评审）

- 密钥扫描本地依赖 gitleaks 安装与否（CI 恒定兜底）。
- server/web/kbservice 互不 import 暂无 import-linter 类机械检查（当前无跨目录代码，出现即补）。
