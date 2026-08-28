# ds-harness 工程质量控制分析 × eng-init 迭代建议

- 日期:2026-08-02
- 分析对象:`/Users/chenwenjie/workspaces/ds-harness`(DeepSeek Harness SDK,plugin-based agent harness monorepo,几乎完全由 coding agent 开发)
- 对照对象:eng-init skill v3.0.0(本目录上级)
- 用途:作为 eng-init 后续迭代的输入材料;建议实施时按 P0 → P1 → P2 逐条落地,每条配 `evals/cases.md` 回归 case

---

## TLDR

ds-harness 的质量控制体系建立在一个 eng-init 尚未显式采纳的成本模型上:**"agent 遵守被强制的门禁远比遵守散文约定可靠;当劳动力由 agent 承担时,'工作量大'不构成成本论据——推理便宜,评审注意力才是稀缺资源。"**(出处:`.agents/notes/implemented/process/2026-06-11-quality-gates.md`)由此推导出约 60 条自动化门禁和 5 个罕见机制家族。

对比 eng-init v3.0.0:两者哲学高度同源(no phantom enforcement、baseline/ratchet、anti-cheat、guardrail self-test 均已覆盖),真正的差距集中在 **6 个只有在高压实战中才显形的缺陷类**:

1. CI 假绿向量(skipped required check 算通过、secret 缺失静默跳过)
2. 覆盖率结构漏洞(全局阈值让大文件补贴裸文件)
3. normalizer 膨胀作弊(用测试基础设施吸收真实行为差异)
4. 自述验证(对 agent 输出做关键词探测,作弊的 agent 能通过)
5. 弱新鲜度信号(mtime vs 派生等式断言)
6. 缺决策记忆(重复辩论、重复推导无处沉淀)

---

## 第一部分:ds-harness 工程质量控制全景

### 1.1 门禁基础设施

**Gate 聚合器**(`scripts/run-gates.ts`):

- 约 60 条 leaf gate,单一真相源在 TS 代码里;14 个聚合 mode(`ci-primary` / `ci-static` / `ci-coverage` / `ci-snapshot` / `ci-consumers` / `ci-windows-*` / `node-compat` / `check-all` / `doc-sync` 等)
- Gate 数据模型带依赖边(DAG):`{ id, label, command, args, needs, env, allowFailure }`
- `validateGateGraph()` 在启动任何子进程之前拒绝:空图 / 重复 id / 依赖未知 id / 依赖成环
- 有界并发调度;依赖失败 → 下游标 `skipped` 并附原因;`error` / `exit N` / `signal X` 三个事实独立上报,不互相掩盖
- 并发默认值按 mode 定制(doc-sync 封顶 4:多个 doc gate 各建完整 `ts.Program`,不封顶会用墙钟换 OOM)
- **CI YAML 只负责提供 runner,不复制 gate 清单**(决策记录:`2026-07-06-parallel-pre-push-gates.md`——"每个 leaf 一个 CI job 会重复 checkout/setup/install,并把 scheduler 清单复制进 YAML")

**元门禁(gate 之上的 gate)**,约 20 个 `scripts/*.spec.ts`:

- `run-gates.spec.ts` 钉住图校验、lane 归属(static lane 必须 source-only、consumers lane 拥有唯一 build)
- `ci-workflow.spec.ts` 断言 CI YAML 不变量(如 pnpm setup 步骤必须设 per-runner 隔离的 dest)
- `lint-rule-fingerprint.spec.ts` 用 count + override index + sha256 三重指纹钉住规则集——任何静默改 lint 规则集都会红
- `coverage-exempt.spec.ts` 防豁免名册腐烂(每条豁免的 filter 与 exclude glob 必须选中同一个非空文件集)

**hook 与 CI 分层**(`lefthook.yml` + `2026-07-22-fast-local-git-hooks.md`,显式推翻早期对称设计):

- pre-commit 只做:staged 格式化(eslint --fix)、staged oxlint --fix、third-party notices **再生成而非拒绝**(自动 `git add`)、`git diff --cached --check` 空白、vendor manifest 守卫(改 vendor 源必须同 commit 改 manifest)
- pre-push 只跑增量 typecheck
- 测试、快照、构建、hygiene 全部不进 hook;CI 拥有穷尽矩阵
- 推送纪律(`dsh-pre-push-checks` skill):证据匹配 surface、选最窄检查、绝不默认全量、不因"要 push 了"重跑已过的检查、只报告实际运行过的命令

### 1.2 反"假绿"体系(全仓最一致的防御主线)

- **`all-checks-passed` 聚合 job**(ci.yml):`needs` 全部 6 个阻塞 job + `if: always()`。注释点名:没有 `if: always()`,依赖失败会让此 job skip,而 **GitHub 把 skipped 的 required check 算作通过**。它总是运行,并对 `failure` / `cancelled` / `skipped` 任一结果退出 1。branch protection 只 require 这一个 check。
- **secret preflight 硬失败**(e2e.yml + `2026-06-19-real-api-e2e-ci.md`):secret 消费的 workflow 在可信事件上无条件检查 key 存在性,空 key → `exit 1` + `::error::` 点名要配的 secret。"The guard turns 'secret missing' from an invisible false pass into a visible failure."
- **"存在即为了证明它"的平台上,自跳过算失败**:sandbox.yml 断言 `Test Files 2 passed (2)` 无 skip;Landlock 用 `NALR_REQUIRE_LANDLOCK=1` 让不强制的内核失败而非跳过。
- **CI 强制快照只读 replay**:record/refresh 只许本地跑且每个 diff 人审;CI 若能写 expected output,快照门禁退化为自我确认。
- **环境变量错配 fail loud**:`DSH_COVERAGE_EXEMPT_HEAVY` 设了但不等于 `'1'` 时 config 直接 throw("set-but-not-'1' 是配置错误,不是静默 no-op")。

### 1.3 覆盖率哲学

`vitest.config.ts`:`thresholds: { perFile: true, statements/branches/functions/lines: 100 }`,范围 `packages/*/*/src/**`。

- **per-file 而非全局**:"Per-file so a well-covered big file can't subsidize a bare one."
- **观念反转**(docs/testing.md):"An uncovered line is often dead code the gate is correctly flagging for deletion, not a missing test to bolt on." —— 覆盖率门禁被重新定义为死代码探测器。
- **例外必须窄、署名、可枚举**:`/* v8 ignore */` 必须带理由;exclude 每组带 `TODO(gui)` 归属与退出条件。
- **豁免的形式化准入契约**(`scripts/coverage-exempt.ts`):一个 suite 只有在"它进程内执行的每个被统计文件都已被其他 suite 完全覆盖"(即移除它不改变任何阈值结果)时才有资格豁免;且豁免 suite 仍以未插桩方式在并行 gate 里完整运行——只省 v8 插桩税,不砍正确性信号。
- **已知畸变激励记录在案**:"100%-coverage pressure can produce assertion-free tests — mutation testing is the planned counterweight"(对冲计划在 `proposed/testing/2026-06-11-mutation-testing.md`)。

### 1.4 测试真实性原则族(docs/testing.md,仅 49 行,受词数预算约束)

- **Verify the world, not the self-report**:对 agent 输出做关键词探测会让作弊的 agent 通过测试;断言必须重新执行命令或从外部重读文件,并断言未触碰的文件逐字节相同。
- **A guard only guards if the regression actually fails it**:守卫测试必须实证走一遍"引入回归 → 变红 → revert"。(postmortem 0001 的教训:178 个 keyless 测试全绿,真实 ACP client session 秒崩——无 `inject` 的 export shape 坏掉时 Loader smoke 依然绿。)
- **Fix fixtures, not normalizers**:平台差异一律改 fixture;normalizer 保持为语义固定的纯函数集,禁止用测试基础设施抹平产品真实行为差异。
- **测试真实入口路径**:package `bin` 必须以纯 `node` 跑构建后的 `lib/bin.js`;产品可见插件必须经真实 Loader + cordis.yml 组合测试,只 mock 外部/非确定性边界。
- **快照三模式**:`replay`(keyless 默认,CI 唯一模式)/ `record`(需 key,本地)/ `refresh`(keyless,本地);replay/refresh 永不加载 `.env`。
- **最小 churn 设计**:恰好一个 scenario pin 完整 system-prompt/tool-schema,其余 tokenize 成 `{{system}}`——prompt 改动只 churn 一行,保住 diff 可审阅性。
- **Prefer the real implementation over a mock**:只 mock 昂贵或非确定性边界(LLM adapter、network、clock),下游全部真实。
- **Trust TypeScript at typed same-process seams**(反方向的克制):禁止为静态类型已保证的值写运行时校验、兜底、敌意输入测试;校验只在真实边界(parser/config、queued、model/tool JSON、durable/file、worker、process、wire)。
- **Tests describe behavior, not correctness**:行为过时就连同测试一起改,并在 PR 里解释为什么。
- **设计期点名覆盖层级**:新 seam / lifecycle 形状 / transcript surface 在 plan 阶段就要点名 unit/e2e/snapshot 每层覆盖,先验证 harness 能表达它;"缺 snapshot harness 支持"是实现的一部分,不是可延后的 follow-up。
- **测试子进程启动模式三选一并声明契约**(built lib 经共享 launcher / 纯 Node 跑 erasable .ts / 显式 src——最后者必须在测试里写明契约)。

### 1.5 文档即门禁(doc-sync lane,24 条 leaf)

- **生成器 + `--check` 双模**:9 个 `gen-*.ts`(cordis-catalog、tool-catalog、config-catalog、persistence-catalog、doc-graphs、scoped-events、module-graph、third-party-notices 等)都提供 `--check`,把文档新鲜度变成可执行的相等性断言。文档漂移 = CI 红。tool-catalog 靠真实 boot 每个 tool 插件收集 schema 生成。
- **word budgets**(`verify-doc-budgets.ts` + manifest):standing docs 有 `wc -w` 上限;红了按固定顺序处理:**relocate → condense → raise**,提额必须在 PR 里书面辩护(manifest diff 本身就是可审阅动作);反向保护:"Ceilings are guardrails, not reduction targets... A too-low ceiling is a budget bug"(保留 ≥5% headroom);被预算文件缺失也算失败(防重命名孤儿化预算)。预算范围刻意狭窄:只管易累积的 standing docs,参考文档/Note/README 不设预算("当每一行都是事实时,长是合法的")。
- **type-equiv**(`verify-type-equiv.ts` + 44.7K manifest):文档里粘贴的类型声明必须与源码符号逐结构一致,含每条原始 JSDoc;`public-api` 投影省略函数体与 private 成员;doc×symbol×projection 强制 1:1。
- **doc-typecheck**:文档 ` ```ts ` fence 必须能对 workspace API 编译;opt-out 比例硬上限 50%("太多块 opt out,让它们编译或删掉")。
- **one physical line per paragraph**(`verify-md-wrap.ts`,GFM AST 判定):硬折行让"改一个词"产生整段 diff;一段一物理行让 diff 可定位。
- **markdown-links / doc-refs**:相对链接必须可解析;TS 注释里的 `docs/*.md` 引用必须存在。已声明盲区:不检查 `#anchor` 有效性——移交人工。
- **每个 gate 显式声明自己的盲区并移交 review**:i18n README 的表述最完整——"a green gate means the pair was confirmed consistent at these exact contents, not that the confirmation was sound... A re-recorded pair with a sloppy counterpart passes the gate; it must not pass review."

### 1.6 包契约门禁

- **explained empty companion**(`scripts/package-invariants.ts`):每包必须注册 invariant companion,二选一——检查一个真实的 event/data 关系,或给空 installer 一个包特定的 `No runtime invariant: <理由>` 标记。gate 拒绝三态:样板生成物、无解释的空实现、被忽略的 reporter。构建产物上再验一次(`verify-built-package-invariants`)。
- **README 段落 gate + 需辩护的 allowlist**:`## Known Limitations and Deferred Work` 与 `## Model Experience` 必须存在且合规;确实不适用的包走带理由的 allowlist(省略也要审计过)。
- workspace constraints:每包 private、cordis peer+dev 版本域一致、exports 精确目标、目录层级严格。

### 1.7 知识管理(决策记忆)

**Agent Notes**(`.agents/notes/`,当前规模:implemented 343 / archived 82 / proposed 25 / rejected 13):

- 每个非平凡变更同 PR 强制至少一条(靠 review 强制——故意不做自动 gate,因为机械检查判断不了语义上的 trivial,且会诱发表面合规)
- 路径即元数据:`{lifecycle}/{class}/yyyy-mm-dd-topic.md`,lifecycle 闭集(proposed/implemented/rejected)、class 闭集(feature/bug-fix/simplification/architecture/process/testing),由 `verify-agent-note-classification` 强制;刻意无 INDEX.md(合并热点)
- 统一格式由 `verify-agent-note-format` 强制:`Status:` 行与文件夹一致;**`## Alternatives considered` 强制存在**("记录了决策却没记录它击败了什么,就是在邀请重新辩论");`implemented/` 里禁用 Proposal/Plan/Migration plan/Acceptance criteria(spec-speak);诚实的祖父条款——格式采纳日 `2026-07-05` 硬编码在脚本里,grandfather 注释只对早于该日期的文件生效
- 写新 note 触发强制取代检查(写替代品的人证据最新,不许推迟到周期性审计);完全取代的删除有严格保全规则(每条独有 rationale/alternative/consequence 必须迁移,禁止把旧文件改写成反面,禁止把 git 历史当 rationale 唯一副本)
- implemented note 就地更新过期事实、不追加变更历史;但决策反转必须新开 note 交叉链接

**冻结归档**(`verify-archived-agent-notes.ts` + append-only manifest):

- 只有 implemented 能归档;proposed 过时应走 rejected,不许靠归档躲判决
- 归档允许的编辑仅四项(移动三元组、插入 `Archived:` 行、重录 sidecar、修复入站链接);封存后永久冻结,所有演进中的文档 gate 跳过归档源——消除"后来的标准倒逼改写历史"的压力
- append-only SHA-256 manifest:`--write` 先证明每条既有封印未变才追加;CI 提供可信 base SHA + 完整历史 checkout,浅克隆无法绕过基线
- 判断标准是语义而非大小(`dsh-archive-agent-notes` 的校准样例:248 词保留 vs 1498 词归档)

**Postmortem**(`docs/postmortem/`):三条件同时满足才写(subtle + systemic + costly to rediscover);Executive summary 开篇;必须链接催生的护栏;是唯一允许战争故事叙事的层;含 `## Why every test missed it (the real failure)` 一节。

**带自毁条款的临时政策**(根 AGENTS.md "Pre-release stance"):第一句加粗 `**Remove this section at the first tagged release.**`;显式陈述有效前提("With no external consumers");给出可执行推论(backend 拒绝旧格式而非迁移、SCHEMA_VERSION 单调、无兼容承诺);标题即权衡命名("foundation over blast radius")。无自动 gate,强制来自引用密度(20+ 篇 note 援引它作为决策依据)。

**知识分层**(docs/AGENTS.md tier 表):one home per fact;每层显式列出"不属于这里的东西";根 AGENTS.md 只留一行规则 + 链接到 owning rationale("Root AGENTS.md carries the one-line rule; this note owns the rationale and the bar")。

**流程 skill**(`.agents/skills/dsh-*`,10 个):每个都是"曾经反复出错或反复重新推导的判断"的固化;共同元规则——声明自己是 guidance 而非 checklist、链接真理来源而不复述、给出本仓库特有的失败模式。代表:`dsh-merging-stacked-prs` 把"删 base 分支自动关闭依赖 PR"的静默数据丢失固化成不变式("a branch may be deleted only when no open PR bases on it");`dsh-code-review` 有证据驱动的自维护回路(收割被实际采纳的人类评审意见 → 双 adapter 裁决 → operator 终审 → "Do not commit adapter output verbatim")。

**实证细节**:即使在这个门禁密度下,分析中仍发现一处漂移——`docs/AGENTS.md` 散文里的预算数字与 `doc-budgets.manifest.json` 实际值不一致(如 AGENTS.md 散文写 ≤1600,manifest 实际 1775)。同一数字放两个家必然漂移;manifest 是权威(gate 读它),散文副本落后了。这正是 "one home per fact" 要机械化而非靠自觉的证据。

---

## 第二部分:eng-init 已覆盖清单(不要重复引入)

| 领域 | eng-init 已有机制 |
|---|---|
| 幽灵强制 | No phantom enforcement 检查、Enforcement Index、`scripts/test-guardrails.sh`(造违例断言非零退出,126/127 算 FAIL) |
| 遗留违例 | baseline freeze + ratchet 表 + Q1.4b、`violation_baseline_tracked` |
| 反漂移 | anti-drift trio(重复/死代码/命名守卫)、`_v2` 文件防御 |
| 重构防作弊 | Source of Truth 契约、compare oracle、"不许削弱 compare tests/snapshots/fixtures"、中间态 oracle、禁止 shell out 到 legacy |
| 严格度 | L1–L4 profile 强制显问、降级需台账、"mostly warn on L3-L4 = 弱配置穿严格外衣"的显式批判 |
| 评分诚实 | configured-but-not-blocking 半分、拒绝 metric gaming、分母稳定性、Class D 不许本地假完成 |
| 生成段落 | generated-section registry(只更新自己拥有的段落,保护用户手写内容) |
| 运行时证据 | PR 模板 Runtime evidence 段、dev-server lifecycle、smoke/seed、AGENTS.md liveness check |
| 自我维护 | evals/cases.md 34 个回归 case、registry 校验脚本 |

---

## 第三部分:迭代建议(按优先级)

### P0 —— 模板/判据级确定性修复

**1. CI 聚合 job:`all-checks-passed` + `if: always()`**

- 缺陷:eng-init CI 模板让各 job 直接作为 required check;GitHub 把 skipped 的 required check 算作通过——依赖失败导致 job 被 skip 时分支保护形同虚设。
- 修复:CI 模板末尾加聚合 job(`needs` 全部阻塞 job、`if: always()`、对 failure/cancelled/skipped 任一结果退出 1),branch protection 只 require 它。
- 落点:`references/aux-file-templates.md` § CI workflow;`readiness-registry.yaml` 新判据(如 `ci_aggregator_gate`);`branch_protection` 修复配方简化。

**2. "自跳过报绿"反模式家族**

- secret preflight:secret 依赖的 workflow 必须先做无条件存在性检查,空值 → 硬失败 + `::error::` 点名。
- 条件跳过审计:审计 `skipIf` / `if:` / `continue-on-error` / `|| true`;"存在即为了证明某能力"的 job 自跳过必须算失败(断言 "N passed, 0 skipped" 或等效开关)。
- Anti-patterns 增加:"Do not let a suite that exists to prove a capability self-skip into green."
- 落点:SKILL.md Anti-patterns;`references/agent-harness-templates.md` 新增 § Secret preflight;audit 判据。

**3. 覆盖率判据升级:per-file + 死代码重释 + 豁免退出条件**

- L3 推荐 / L4 默认 per-file 阈值(按栈给模板:vitest `perFile: true`、pytest 按包拆分等)。
- AGENTS.md 覆盖率段写入:"未覆盖行的第一解释是死代码候选,不是缺测试"——直接对冲"100% 催生垃圾测试"的最大反对理由。
- 豁免规则:每条 ignore/exclude 必须带理由;exclude 条目带退出条件(constraints.yaml `exemptions` 加可选 `exit_condition` 字段)。
- 落点:`references/lang-constraints.md`、`references/aux-file-templates.md` 各栈覆盖率配置、`references/agents-md-sections.md` Coverage threshold 段、`references/constraints-yaml-template.md`。

**4. Anti-cheat 补两条作弊向量**

- **normalizer 膨胀**:比较失败时往规范化层加规则 = 用测试基础设施吸收真实行为差异。规则:"fix fixtures/product, not normalizers";normalizer 是语义固定的纯函数集,新增规则需独立辩护。
- **CI 可写快照**:快照/compare 的 update/record 是本地显式操作且每个 diff 人审;CI 一律只读 verify。
- 落点:SKILL.md Anti-patterns;`references/agents-md-sections.md` § Source of Truth & Refactor Contract;Pillar 4 Deterministic test setup。

**5. Evidence requirements 增加 "Verify the world, not the self-report"**

- "agent 声称做了 X"的验证必须观测世界(重新执行命令、外部重读文件、打真实 endpoint、查 DB 行),禁止对 agent transcript/输出做关键词探测;伴生断言:未触碰的资源逐字节不变。
- 对 eng-init 核心受众(AI-agent 开发的仓库)价值极高。
- 落点:`references/agents-md-sections.md` § Evidence requirements;`references/agent-harness-templates.md` smoke/e2e 指导。

**6. Conventions 加 TODO 三级语义(近零成本)**

- `FIXME` = 应阻塞下一次发布 / `TODO` = 有资源尽快 / `XXX` = 也许某天、无承诺;`tech_debt_tracking` 扫描器按级分类。
- 落点:`references/agents-md-sections.md` § Conventions。

### P1 —— 机制引入

**7. 文档新鲜度:mtime 弱版 → 派生等式强版**

- 现状:`documentation_freshness` = "180 天内 touch 过"(touch 不证明正确,没 touch 不证明过期)。
- 强版:目录型文档从源码生成,`gen-X --check` 把新鲜度变成相等性断言。新增判据 `generated_docs_check_mode`;Doc Freshness Rules 维度标注散文规则为弱形式、generator+check 为强形式。
- 落点:`references/agent-readiness-criteria.md` + registry + `references/agent-harness-templates.md` generator/check 骨架。

**8. L3+/monorepo 的 gate-runner-in-code 模式(可选)**

- 被测试的 gate runner 脚本拥有清单与依赖图(启动前校验、依赖失败→显式 skipped、缓冲输出、有界并发);YAML 只提供 runner。
- 元门禁:gate 逻辑自身有 spec;规则集指纹测试(dump 生效规则 → sha256 → 与已提交指纹比对,静默改规则集必红)——极便宜的通用模板。
- 落点:`references/agent-harness-templates.md` 新 §(L3+ 可选);`references/eng-pillars.md` Pillar 5 提及。

**9. "证据匹配 surface"的范围化验证协议**

- AGENTS.md 增加"变更类型 → 最窄证据"映射表(行为→聚焦测试;模型/用户可见输出→快照;文档→doc 门禁;发布路径→build+built smoke)。
- `change-scope` 确定性脚本模板:要求显式 `--base`、从不猜测/fetch、输出 committed/staged/unstaged/untracked 四层清单,作为选择检查的输入。
- 纪律:只报告实际运行过的命令;不因"要 push"仪式性重跑已过检查;测试选择与覆盖率选择是两件事,禁止 `--passWithNoTests` 或收窄 include 掩盖未覆盖的受影响文件。
- 落点:`references/agents-md-sections.md` 新增小节 + `references/agent-harness-templates.md` change-scope 模板。(与现有 `check-fast` 互补,不冲突。)

**10. "强制存在 + 强制解释缺席"命名为守卫设计原则**

- 模式:凡"每个 X 必须有 Y"的规则,gate 接受两态——真实的 Y,或带署名理由的显式缺席标记(`No runtime invariant: <理由>`、带理由的 allowlist);拒绝第三态(静默空缺/样板应付)。
- eng-init 局部已这么做(Runtime evidence "None — review-only" 需理由、Skippable 需 non-applicability),提炼成显式原则让未来所有新守卫默认按此形状设计;同时消灭"应付式空壳"和"沉默跳过"两个腐化方向。
- 落点:`references/eng-pillars.md`。

**11. 临时政策必须内嵌自毁条款**

- 渲染规则 + 反模式:"任何带时限的规则必须在正文第一句写明移除条件;没有移除触发器的临时政策是永久债务。"适用:baseline freeze、rehabilitation 状态、兼容层条款。
- 完整形态参照 ds-harness "Pre-release stance":第一句加粗移除触发条件、显式有效前提、可执行推论而非态度、标题即权衡命名。
- 落点:`references/agents-md-sections.md` Rendering rules + SKILL.md Anti-patterns 各一句。

**12. Enforcement Index 增加"盲区"声明**

- 每个 gate 写明"绿了不代表什么",盲区正式移交 review(参照:"配对 hash 不证明翻译质量;它必须过不了 review")。
- Enforcement Index 加可选列 "Blind spot / hand-off to review",与 gray-box review policy 打通——Code Review Self-Check 由各 gate 已声明盲区推导,而非独立清单。
- 落点:`references/agents-md-sections.md` § Enforcement Index。

**13. 决策记录作为 L3+/多 agent 可选模块(重新考虑 "Never by default: ADR")**

- ds-harness 证明:对 agent 密集开发的仓库,决策记忆是防止重复辩论/重复推导的核心装置,且最小可行契约很小:lifecycle 目录 + 强制 `## Alternatives considered`("不记录击败了什么就是邀请重新辩论")+ 写新记录时强制查旧记录取代。
- 作为可选模块(grill 问一次),产出 `decisions/` 最小骨架;完整冻结归档/manifest 机制不移植。
- 落点:question-bank 加一问 + `references/aux-file-templates.md` 最小模板 + Protocol 层证据。

### P2 —— 理念层与长线

**14. standing docs 的 word-budget 门禁**:manifest + `wc -w` gate + relocate→condense→raise 有序策略 + "过低上限是 budget bug"反向保护 + 被预算文件缺失也算失败。是 eng-init "concise hard kernel" 250 行散文规则的机械化强形式。

**15. 文档代码块必须编译**(doc-typecheck + opt-out 比例上限)作为 L4 可选 doc 门禁。

**16. 畸变激励审计**:audit 报告可选小节——每个高压 gate 写明已知 gaming 向量与规划的对冲(如 100% coverage → 无断言测试 → mutation testing)。

**17. review 反馈收割回路**:extend "rule of three" 与 incident-to-constraint ratchet——机械化收割被实际采纳的人类评审意见 → 对照现行规则分类 → 裁决 → 终审("Do not commit adapter output verbatim";"没有候选是常态,不是停滞")。

**18. Postmortem 模板 + 三条件**(subtle / systemic / costly to rediscover;Executive summary 开篇;必须链接催生的护栏;含 "Why every test missed it" 节)进 `references/aux-file-templates.md`,与 ratchet 闭环。

**19. 日期锚定的祖父条款**:新格式规则采纳时硬编码采纳日期,grandfather 标记只对早于该日期的文件生效——比纯计数 baseline 更精确的冻结方式,作为 baseline 机制补充选项。

**20. Q1.4 成本模型注记**:严格度推荐目前由生命周期驱动;补一条——仓库若主要由 agent 开发,机械化上限应上调。"工作量大"在 agent 承担劳动时不是反对 L4 的论据,评审注意力才是要优化的稀缺资源。这是 ds-harness 整个体系的第一性原理,也是对 "Strictness is a chosen profile" 原则的最好补充。

### 测试哲学层面可吸收进 TDD/测试条款的观念(不改结构,补措辞)

- "A guard only guards if the regression actually fails it"——守卫测试要实证红→revert(guardrail self-test 精神向测试层的延伸)。
- "Tests describe behavior, not correctness"——行为过时连测试一起改,PR 里解释。
- "Trust the type system at typed same-process seams"——反测试膨胀:不为静态已保证的值写防御与敌意输入测试;校验只在真实边界。
- "设计期点名覆盖层级"——缺测试基础设施支持是实现的一部分,不是 deferred follow-up。

---

## 第四部分:明确不移植的部分

| 机制 | 不移植原因 | 已提取的可迁移内核 |
|---|---|---|
| 双语配对契约(blob-hash 三件套、最小补丁翻译) | 依赖仓库双语,通用性不足 | —— |
| package invariant companion、Model-visible ⟺ logged | 产品架构特定 | "强制存在+解释缺席"原则(P1-10) |
| Wine-Windows CI、vendored 源清单守卫、sandbox 内核证明 | 基础设施特定 | 自跳过算失败(P0-2) |
| 完整冻结归档 manifest 机械 | 对 bootstrap 场景过重 | 决策记录最小契约(P1-13) |
| oxlint 逐条显式规则清单(不启用 category) | 栈特定的运维选择 | 规则集指纹(P1-8) |

---

## 第五部分:实施建议

- 按 eng-init 自身维护惯例:每条 P0/P1 在 `evals/cases.md` 增加回归 case,建议编号衔接现有 case-34:
  - case-35 `ci-aggregator-always`:渲染的 CI 必须含聚合 job 且 `if: always()`;缺失 → 判据失败
  - case-36 `secret-preflight-hard-fail`:secret 依赖 workflow 无 preflight → 报 readiness gap,不许静默
  - case-37 `per-file-coverage-l4`:L4 profile 下渲染 per-file 阈值;全局阈值降级需台账
  - case-38 `normalizer-growth-rejected`:refactor 模式下"往 normalizer 加规则让 compare 过"被识别为作弊
  - case-39 `world-verification-evidence`:agent 自述型断言不算 runtime evidence
  - case-40 `temporary-policy-self-terminates`:渲染的临时条款必须带移除触发器
- registry 改动跑 `scripts/check_readiness_registry.py references/readiness-registry.yaml`。
- P0 六条改动集中在 4 个文件(SKILL.md、aux-file-templates、agents-md-sections、readiness-registry),彼此独立,可逐条落。

## 收束

eng-init 擅长的是把控制平面装进一个陌生仓库;ds-harness 展示的是控制平面在 agent 密集开发下满配运行数月后长成的样子。它验证了 eng-init 的方向,并暴露了六个只有在高压运行中才显形的漏洞(假绿向量、覆盖率结构漏洞、normalizer 作弊、自述验证、弱新鲜度、缺决策记忆)。这批学习的价值正在于:它们不是理念分歧,而是同一哲学在实战里打出来的补丁。

---

## 附录 A:代码是否变成了"自维护的文档知识库"?

问题:ds-harness 是否把代码变成文档知识库,从而不用自己维护文档?

结论:**一半是,一半刻意不是**。它没有整体"代码变文档",而是把文档严格切成两个平面,只把可推导的平面交给生成;"不用维护"在两个平面上都不完全成立——维护成本没有消失,而是被搬迁到更便宜的位置并机械化。

### A.1 投影平面:可从代码推导的事实 → 全自动生成,输出零手工维护

9 个生成器,全部 `gen-X.ts` / `--check` 成对:

| 生成物 | 来源 | 讲究 |
|---|---|---|
| cordis-catalog(events/services)| 源码声明合并 + JSDoc | 静态解析类型图 |
| tool-catalog | **真实 boot 每个 tool 插件**收集 schema | 从运行时真相生成;manifest 必须覆盖磁盘上所有 `tool-*` 包——新包不可能默默漏出目录 |
| config-catalog | 每包 Config 类型 | 每个可枚举 schema path 必须真实存在于声明类型上 |
| persistence-catalog | `SessionEventMap` 声明合并 | 事件必须显式类型、有文档、声明唯一 |
| module-graph | in-repo `peerDependencies` | 与真实依赖图相等性断言 |
| doc-graphs / scoped-events / third-party-notices | 源码扫描 | notices 在 pre-commit 自动再生成 + `git add`(再生成而非拒绝) |
| 网站 | `website/docs.ts` 允许清单 → 一次性 `.generated/` 树 | 网站是被测试的投影,不存在第二份内容源 |

三条使之成立的纪律:

1. 生成物禁止一切手改(tier 表明文)。
2. 每个生成器配 `--check`,新鲜度是 CI 相等性断言——漂移 = 红灯,不是评审提问。
3. **先把源头注释变成门禁**(最关键、最易被忽略):`verify-export-jsdoc` 强制每个导出有 JSDoc、函数有 `@param`/`@returns`、事件有 `@mode` + payload `@param`、未知形态 fail closed。文档生成的质量上限 = 源码注释的质量下限;ds-harness 是先立法"代码必须自带文档",然后才有资格说"文档从代码生成"。

该平面的"维护"= 写代码时在声明处写一次 JSDoc(gate 强制)+ 维护生成器(自身有 spec)。输出侧确实零手工维护。

### A.2 权威平面:代码表达不了的知识 → 手写,但机械锚定到代码

architecture.md、AGENTS.md、cookbook、README 契约段承载的信息(why、边界、程序、地图)在代码里不存在,不可能生成。做法不是生成而是装锚:

- type-equiv:文档粘贴的类型声明必须与源符号逐结构一致(含每条原始 JSDoc),manifest 强制 1:1;
- doc-typecheck:文档 ts 代码块必须编译,opt-out ≤50%;
- md-links / doc-refs / package-paths:所有路径引用必须可解析(含 TS 注释里的 `docs/*.md`);
- doc-budgets:防膨胀 ratchet;
- README 段落 gate + 带理由 allowlist:强制存在或强制解释缺席;
- docs-accompany-code:行为变了同一 commit 更新 prose——**此条无 gate**,是残余人工义务,靠 review + prose standard。

### A.3 纯人工层:刻意不自动化

Agent Notes / postmortem / cookbook。反例值得记录:"每个非平凡变更必须带 Note" **故意不做自动 gate**——决策记录驳回了 CI diff-classification gate 方案(机械检查判断不了语义 trivial,且诱发表面合规)。这层防腐烂靠流程装置(one home per fact、就地更新、强制取代检查、冻结归档),不靠生成。体系最清醒之处:精确区分可推导与不可推导,从不假装后者能自动化。

### A.4 经济学:维护成本去哪了

- 传统模式:散文 N 处手写手同步 → 必然漂移(实证:本仓库自己在预算数字上漂了,散文 ≤1600 vs manifest 1775);
- "全自动文档"幻想:只能生成事实目录,生成不了 why 和契约,且质量受注释天花板压制;
- ds-harness 模式:逐类事实二分——可推导 → 生成 + check + 禁手改;不可推导 → 唯一的家 + 机械锚 + 同 commit 义务。

成本被搬到三个更便宜的位置:声明处 JSDoc(离真相最近、写一次、gate 强制)、生成器代码(集中、有测试)、门禁本身(执行者是 agent)。世界观声明(根 AGENTS.md):"Generated and derived artifacts are projections... Never patch a derived output as the source of truth." —— 生成物是投影,权威永远在源码。

### A.5 诚实的边界

1. type-equiv 抓"漂移的粘贴",不抓"从未被文档化的新类型"(文档自己承认);
2. `#heading` 锚点有效性不检查,移交人工;
3. 双语未进生成:生成器只出英文,中文对被排除在配对契约外(已记录计划:教生成器产出中文后移出排除清单);
4. 同 commit 更新义务无 gate,是最大的纯人工残留;
5. 生成器本身是要维护的代码(quality-gates note 承认"gate 本身也是要维护的代码")。

### A.6 可复制的四步配方(对 eng-init 与一般实践)

1. **逐类事实先问:能从代码推导吗?** 可推导:API/事件/配置目录、依赖图、CLI help、schema、license notices;不可推导:why、契约语义、程序、地图。
2. 可推导 → generator + `--check` + 禁手改,并给生成器配**覆盖完整性检查**(防"新东西默默不进目录")。即本报告 P1-7 的完整形态。
3. 不可推导 → 唯一的家 + 机械锚(轻量版:文档代码块必须编译、链接必须解析)+ 同 commit 义务。
4. **先把源头注释变成门禁**(export-jsdoc 类 gate)——第 2 步的前置条件,顺序不能反。

一句话:不是"代码自动变成文档",而是"把所有能变成投影的文档变成投影,把剩下的手写文档锚死在代码上,把源码注释本身变成强制项"——维护工作从"同步 N 份散文"变成"在声明处写一次 + 让机器盯漂移"。

---

## 附录 B:harness engineering 逐域蒸馏目录(第二轮分析)

第一轮看"有哪些门禁";本轮看更深一层:**ds-harness 对自己的 harness(测试执行器、快照系统、gate 调度器、hook 安装器、翻译工具链)施加了与产品代码同等的质量控制**。四条元原则,eng-init 目前没有对应物:

1. **Harness 的表达力是特性范围的一部分**——设计期验证"现有 harness 能表达这个覆盖吗",不能就先扩 harness;"缺 snapshot 支持"不是 follow-up,是实现的一部分(根 AGENTS.md 明文)。
2. **Harness 为自己的输入设门禁**——快照 suite factory 拒绝孤儿 scenario 目录/重复 pin/未 scrub fixture;覆盖率豁免名册有守卫测试;gate 调度器启动前校验自己的依赖图。
3. **可审阅性是 harness 的一等设计需求**——"一次逻辑变更 = 一行可审 diff"被工程化(pin-once-tokenize-elsewhere、refresh 双射算法、翻译最小补丁)。"评审注意力稀缺"直接塑造 harness 算法设计。
4. **每个非默认配置写明动机性失败模式**——vitest 池选择、并发封顶、每条 lint off、空 catch 全部带"为什么"的行内注释;没有理由的偏离活不过下一次"简化"。

### B.1 Gate 调度 harness(`scripts/run-gates.ts`)

| 机制 | 蒸馏原则 | eng-init 处置 |
|---|---|---|
| `validateGateGraph()` 启动前拒绝空图/重复 id/未知依赖/环 | 调度器先验证自己的输入 | P1-8 |
| 依赖失败 → 下游显式 `skipped` + 原因 | 跳过必须可见可归因 | P0-2 |
| `error` / `exit N` / `signal X` 三事实独立上报 | 正交结果独立上报,不嵌套掩盖 | **新 34** |
| `stdio: pipe` 缓冲输出保证并发归属;`spawn` 无 shell(Windows `pnpm.cmd` 注释) | 并发 harness 的日志必须可归属 | P1-8 模板注记 |
| 并发默认值按 mode 定制且带理由(doc-sync 封顶 4:防 `ts.Program` OOM) | 配置偏离带动机性失败模式 | **新 23** |
| `parseMode` 未知值 throw | misconfiguration fails loud | **新 25** |
| `run-gates.spec.ts` 钉住 lane 归属与依赖边 | gate 逻辑自身有 spec | P1-8 |

### B.2 测试执行 harness(vitest 配置族)

| 机制 | 蒸馏原则 | eng-init 处置 |
|---|---|---|
| `test-invariants.ts` 作为全局 `setupFiles` 猴补 registry:每个测试自动在其包的运行时不变量监督下运行;拓扑测试保证聚合覆盖 | 运行时不变量挂进 harness,而不是靠专门测试想起来才查 | 产品架构特定,提取理念进 B.0 元原则;不单列 |
| `thread-safe` vs `process-bound` 双池,每条池选择注释具体失败模式(Node 24 CJS lexer worker abort 等) | 测试基础设施的每个非默认选择记录动机 | **新 23** |
| `DSH_COVERAGE_EXEMPT_HEAVY` 设了但非 `'1'` → config 直接 throw | env 开关非法值是配置错误,不是静默 no-op | **新 25** |
| 三份 vitest config 同款注释:paths 指向 `tsconfig.base.json`(无 include = match-all facade),bare import 永不落到 `lib/` | source plane / artifact plane 严格分离;产物只被显式消费 | 已在第一部分;架构特定,不单列 |
| 共享 fixture 只能放 `tests/harness.ts`,禁 import 其他 `*.e2e.ts`(会重新注册 describe,翻倍真实 API 调用) | harness 复用有显式形态,禁止 spec 互相 import | P2 测试观念补充 |
| e2e 资源自持有:harness 在测试内创建、`afterEach` dispose(含失败/重试/超时) | 测试拥有自己资源的完整生命周期 | P2 测试观念补充 |

### B.3 覆盖率 harness

| 机制 | 蒸馏原则 | eng-init 处置 |
|---|---|---|
| 双 lane:插桩 gate + 同 suites 未插桩并行 gate | 性能优化只砍插桩税,不砍正确性信号 | P0-3 配套说明 |
| `coverage-exempt.ts` 形式化准入契约:移除豁免不改变任何阈值结果才够格 | 豁免必须可证明无损 | P0-3 |
| `coverage-exempt.spec.ts` 防名册腐烂 | 豁免清单自身有守卫 | P0-3 |
| worker 预算 1/3:2/3 切分,注释写明 failover 池 8×6=48 上限假设 | 资源预算的假设写在切分处 | **新 23** |

### B.4 快照 harness(`packages/support/acp-snapshot` + snapshot config)

| 机制 | 蒸馏原则 | eng-init 处置 |
|---|---|---|
| 三模式:replay(keyless 默认/CI 唯一)/ record(需 key,本地)/ refresh(keyless 更新 expected);replay/refresh 永不加载 `.env` | update 通道与 verify 通道物理分离 | P0-4 |
| fixture guards:suite factory 拒绝孤儿目录、缺文件、一 class 多 pin、重复 sidecar、非规范路径 token、未 scrub header | **harness 为自己的输入设门禁** | **新 27** |
| 恰好一个 scenario pin 完整 system-prompt/tool-schema,其余 tokenize 为 `{{system}}`;每个不同 header 版本只提交一次 | 一次逻辑变更 = 一行可审 diff;最小 churn 是设计需求 | **新 27** |
| refresh 双射算法:仅当布局对齐且易变字符串替换构成双射才复用旧叶子;歧义保留新串 | update 操作以"diff 可人工审阅"为目标函数 | **新 27** |
| normalizer 是语义固定的纯函数集;`normalizeStdout` 兼任 stdout 纯净检查(一个函数两用防两套规则漂移) | normalizer 不许膨胀;规则集中单点 | P0-4 |
| session fixture 必须 canonical packed 布局(独立 gate) | fixture 布局规范化可门禁 | **新 27** |

### B.5 E2E / 真实 API harness

| 机制 | 蒸馏原则 | eng-init 处置 |
|---|---|---|
| secret preflight:可信事件上无条件检查 key,空 → `exit 1` + `::error::` 点名 | secret missing 必须是可见失败 | P0-2 |
| self-skip 是可用性机制不是成本信号;per-provider key 各自 gate | 自跳过语义要显式声明 | P0-2 |
| 注释显式禁止 `pull_request_target`(key 泄漏向量);fork/Dependabot job-level 排除 | secret workflow 的安全形态是惯例 + 注明理由 | **新 30** |
| "We are DeepSeek — do not ration real-API tests" | 与自家产品相关的真实调用不设配额;成本模型按主体校准 | 理念,并入 P2-20 |

### B.6 平台 / 沙箱 harness

| 机制 | 蒸馏原则 | eng-init 处置 |
|---|---|---|
| Wine job:校验和验证过的真实 win-x64 Node;工作树永不被改(快照到 scratch 目录) | 平台 harness 不污染工作树;工具链完整性校验 | 基础设施特定,不迁移 |
| sandbox job 断言 `Test Files 2 passed (2)` 无 skip;`NALR_REQUIRE_LANDLOCK=1` 让不强制内核失败而非跳过 | "存在即为了证明它"的 job 自跳过算失败 | P0-2 |
| windows observational lane 全部 `allowFailure: true` 且与 blocking lane 显式分开 | 观察性信号与阻塞信号显式分层,不混淆 | P1-8 注记 |
| 跨平台测试:用宿主 `node:path` 构造语义,不规范化路径;POSIX-only 原语窄排除 + 相邻跨平台断言 | 保持测试语义,不用基础设施抹平平台差异 | P0-4 同族 |

### B.7 Git / hook / 推送 harness

| 机制 | 蒸馏原则 | eng-init 处置 |
|---|---|---|
| `install-lefthook.mjs`:worktree-local 安装、ownership marker、安装锁、`core.hooksPath` 覆盖保护(35K spec 覆盖) | hook 安装器不 clobber 用户既有 hook;安装本身幂等且被测试 | **新 30** 附带(模板注记) |
| `change-scope.ts`:要求显式 `--base`、从不猜测/fetch、关 rename detection 让重命名两侧可见、禁 fs monitor 与外部 diff 驱动 | 范围报告确定性优先;每个可能引入不确定性的 Git 特性显式关闭 | P1-9 |
| third-party notices pre-commit **再生成而非拒绝** + 诚实记录抓不到的 case(删 manifest 由 test lane 兜底) | 自动修复优于拒绝;修复器声明自己的盲区 | P1-12 同族 |
| vendor 源改动必须同 commit 改 manifest(shell 守卫) | 衍生物与其登记簿原子更新 | 已覆盖(P1-7 同族) |

### B.8 发布 harness

| 机制 | 蒸馏原则 | eng-init 处置 |
|---|---|---|
| GitLab 发布流水线:tag↔version 一致性断言、发布前 4 个 wheel 文件名精确核对、manylinux 容器内冒烟、glibc ≤2.28 断言 | 发布 preflight 断言"要发的就是验过的" | **新 29** |
| `verify-runtime-closure` 同时在 CI 与发布流水线跑 | 部署闭包检查属于发布路径 | **新 29** |
| `serial-linux-selfhosted` 热备演练:每次 master 移动在备用池跑完整 primary gate | **备援路径必须被持续演练**,不是配置了就算有 | **新 28** |
| CI failover 用仓库变量切 `runs-on` 表达式 | 降级开关是显式配置而非改 YAML | 基础设施特定,注记即可 |

### B.9 文档 harness

(主体见附录 A;此处补 harness 工程视角)

| 机制 | 蒸馏原则 | eng-init 处置 |
|---|---|---|
| tool-catalog 靠真实 boot 每个插件生成;manifest 必须覆盖磁盘所有 `tool-*` 包 | 生成器配覆盖完整性检查,防"新东西默默不进目录" | P1-7 |
| 翻译 briefing 生成器:最窄安全对齐粒度、三方文本、机械 diff 直接 `--apply` | 人工步骤最小化:能机械的机械,剩下的给最小工作集 | 双语特定,理念并入 B.0-3 |
| `verify-*` 脚本约 20 个自身有 spec 且进同一测试树 | 文档门禁是被测试的代码 | P1-8 |
| `--list` 永不失败 + 按 pair 窄检查 + "窄绿不替代全绿" | 诊断模式与 gate 模式分离;局部通过不冒充全局 | P1-9 同族 |

### B.10 流程 / 多 agent harness

| 机制 | 蒸馏原则 | eng-init 处置 |
|---|---|---|
| 委派修复 trust-but-verify:"sub-agent 报告描述的是意图,不一定是实际落地的东西";亲自重跑 gate;回归守卫证明在未修复代码上失败;"重新表述成已处理"是深挖信号 | 多 agent 协作需要显式验证协议,报告不是证据 | **新 22** |
| 环境归因必须举证(精确命令、失败测试、平台差异),否则按真实失败处理 | 环境特异性主张是需证命题 | **新 22** 并入 |
| record-browser-gif:证据必须真实 provenance(PR 自己的树、真实 server/key/model round)并在 embed 旁陈述;完成谓词禁子串匹配(用户 prompt 回显也会满足);GIF 走 orphan assets 分支、永不进 PR 分支、只追加 | 证据自带出处;二进制媒体不进代码历史 | **新 21** |
| stacked-PR 不变式:"分支只有在没有 open PR 以它为 base 时才可删除"(平台事实,2026-08-02 ds-harness 政策重写后仍成立);平台有原生 stacked-PR 机制(如 GitHub `gh stack`)时必须使用,由平台拥有栈身份/排序/retargeting/合并态;原生机制不可用时不得使用 stacked-PR 链(禁止逐 PR merge + 手工 retarget 模拟栈),依赖 PR 顺序落地或合并为单一变更;重写已推送历史仅允许 `--force-with-lease`,远端移动即中止 | 不变式固化静默数据丢失危害;平台原生机制长出时迁移而非维护手工复制品;手工栈维护是事故源,硬性禁止 | **新 33** |
| dsh-code-review 自维护回路:收割被实际采纳的人类评审意见 → 双 adapter 裁决 → operator 终审;"Do not commit adapter output verbatim";"没有候选是常态不是停滞" | 规则体系从真实评审中进化,且进化本身有防膨胀护栏 | P2-17 |
| dsh-archive-agent-notes 校准样例:真实字数的保留/归档判例(248 词保留 vs 1498 词归档) | 判断型规则配校准样例优于更多抽象判据 | **新 31** |
| skill 元规则:声明"guidance 不是 checklist"、链接真理来源不复述、只给本仓库特有失败模式 | 流程规则文件的反膨胀三原则 | **新 31** 并入 |
| defensive-patterns 定位:"每条模式都是实际发生(或险些发生)的缺陷类,以防复发规则的形式陈述" | **约束清单从事故中挣得条目**,不是通用最佳实践列表 | **新 24** |
| architecture.md "Where New Behavior Goes" Goal→Mechanism 表(约 18 行);改 agent-loop 必须同 PR 更新架构文档 | 扩展点地图 + 改 spine 的固定文档税 | **新 26** |

### B.11 语言级纪律(根 AGENTS.md conventions)

| 机制 | 蒸馏原则 | eng-init 处置 |
|---|---|---|
| "Misconfiguration fails loud":自包含时 load 期失败,否则最早可解析点;永不静默跳过缺失引用 | 通用规则,直接可写进 universal stack rules | **新 25** |
| "Explicit > implicit at package seams":defaulting 是 owning 实现里显式 `resolve(request): Spec` 步骤,不是 `run()` 里藏 `?? default` | 默认值单点解析 | **新 32** |
| "No hardcoded tunables":deployment-varying 选择必须是可从配置改的验证字段;`DEFAULT_*` 常量不是可配置性;协议常量/安全不变量保持固定 | tunables 二分法:该配置的必须配置,不该配置的必须固定 | **新 32** |
| Branded id(跨边界不透明 id 不用裸 string);闭合 union 以 `assertNever` 收尾、可扩展 union 走文档化 default | 类型系统承担边界纪律 | lang-constraints TS 条款,低成本追加 |
| "An empty catch names what it swallows"且 try 保持单语句 | 沉默处理必须署名 | **新 23** 同族 |
| "Prefer symmetry for parallel values"(无解释的不对称通常是漏掉的提取) | 结构性评审启发式 | Code Review Self-Check 一行 |

### B.12 第二轮新增建议汇总(21–35,衔接首轮 1–20)

**P1**

- **21. Runtime evidence 带 provenance 声明**:证据旁写明来源(哪棵树在服务、真实还是 fixture provenance、哪些 mode);二进制媒体走 orphan assets 分支、永不进 PR 分支、只追加。落点:PR 模板 Runtime evidence 段 + `runtime_evidence_in_pr_template` 判据。
- **22. 委派修复 trust-but-verify 协议**(large-refactor overlay 的 discover/fixer/reviewer 配套):sub-agent 报告是意图非现实,必须亲自重跑 gate;回归守卫证明未修复代码上失败;"重新表述成已处理"是深挖信号;环境归因必须举证。落点:`agents-md-sections.md` § Large-refactor agent roles + Debugging CI failures。
- **25. Misconfiguration fails loud**:配置错误启动/最早可解析点抛出;env 开关非法值 throw 而非静默 no-op;CLI 未知 mode throw;不静默跳过缺失引用。落点:`lang-constraints.md` universal rules + harness 模板。
- **27(P1 部分). 最小 churn 设计**:contract-testing 指南加"共享 header/schema 只 pin 一次其余 tokenize;update 操作以 diff 可审阅为目标函数"。落点:eng-pillars Pillar 4。
- **35. Harness 表达力属于特性范围**:验证计划必须确认现有 harness 能表达所需覆盖;harness 缺口补齐在本特性 scope 内。落点:SKILL.md Stage 3 Verification plan + ddd-tdd-clauses TDD 段。

**P2**

- **23. 配置偏离带理由**:每个非默认配置值/规则关闭/池与并发选择/空 catch 写明动机性失败模式。落点:agents-md Conventions + lang-constraints。
- **24. 约束清单从事故挣得条目**:pitfalls/Important Development Notes 每条来自真实缺陷类,与 incident-to-constraint ratchet 闭环;保持短而承重,显式反对通用最佳实践填充。落点:agents-md-sections 渲染规则。
- **26. 扩展点地图**:Goal→Mechanism 表("想加 X,seam 是 Y");改 spine 必须同 PR 更新该文档。落点:agents-md-sections § Module Boundaries 可选子节。
- **27(P2 部分). Fixture guards**:测试基础设施为自己的输入(fixture/golden 目录)设结构校验。落点:Pillar 4。
- **28. 备援路径持续演练**:`rollback_automation` 类判据从"存在且有文档"强化为"有演练证据"(定期或每次主干移动)。落点:readiness criteria 注记。
- **29. 发布 preflight 断言**:tag↔manifest 版本一致、产物清单精确核对、部署闭包检查进发布流水线。落点:Pillar 6 release 模板。
- **30. CI secret 安全惯例**:禁 `pull_request_target` 于 secret workflow(注明理由)、fork/Dependabot 显式排除、`github.repository ==` 守卫;hook 安装器不 clobber 既有 hook。落点:aux-file-templates CI/hook 模板注释。
- **31. 判断型规则配校准样例**:语义判断规则(归档/取舍/严格度)配真实案例 + 判决 + 指标;流程文件遵守反膨胀三原则(guidance 非 checklist、链接不复述、只列特有失败模式)。落点:eng-init 自身 references 维护原则。
- **32. 显式 defaulting 与 tunables 二分法**:默认值单点解析;deployment-varying 必须进 config,协议/安全不变量必须不进;`DEFAULT_*` 常量不算可配置性。落点:lang-constraints / ddd-tdd-clauses。
- **33. Stacked-PR 分支删除不变式**:"分支只有在没有 open PR 以它为 base 时才可删除";merge 不删分支,全部落地后统一删除。落点:agents-md Conventions § Branch model。
- **34. 正交结果独立上报**:脚本/harness 对 error/exit/signal、timedOut/exitCode 等正交事实独立报告,不嵌套掩盖。落点:agent-harness-templates 脚本惯例。

**第二轮新增 eval case 建议**(衔接 case-40):

- case-41 `runtime-evidence-provenance`:无 provenance 声明的 UI 证据不算 runtime evidence;媒体进 PR 分支被拒
- case-42 `delegated-fix-trust-but-verify`:multi-agent 模式下,渲染的 refactor 协议必须含"亲自重跑 + 回归守卫红→revert"条款
- case-43 `misconfig-fails-loud`:渲染的脚本/配置对非法 env 值必须 throw,静默 no-op 判失败
- case-44 `harness-gap-in-scope`:验证计划声明"现有 harness 表达不了 X"时,必须把 harness 扩展列入 write set 而非 readiness gap 之外的 follow-up
- case-45 `standby-exercised`:声称有 rollback/failover 而无演练证据 → 半分而非满分

### B.13 第二轮收束

首轮结论是"六个高压下才显形的漏洞";本轮补上第七个维度:**eng-init 生成的是 harness,但它还没有把'harness 自身的工程质量'当作对象**。ds-harness 展示了这个层次的完整形态——harness 被测试、harness 为输入设门禁、harness 的算法为评审注意力优化、harness 的每个非默认选择记录动机。对 eng-init 而言,这意味着它渲染的 guardrail 脚本、CI 结构、快照/compare 机制不仅要"存在且阻塞"(现有标准),还应逐步要求"被测试、可归因、最小 churn、fail loud"(新标准)。这是从"装上控制平面"到"控制平面本身可维护"的跨越。
