# eng-init 第一性原理落差审计(v3.4.1,2026-08-10)

## 结论

**eng-init 的核心目的:让一个无法记住上下文、无法自行判断边界的 AI agent,在别人的仓库里改动代码时,错误会被程序拒绝而不是被文档劝阻。**

它自己给这件事定的判据是"约定必须有会拒绝违规的程序"。按这个判据审计它自身:

| 兑现层级 | 判据 | 条数 |
|---|---|---|
| **L3** 机械兑现 | 有非零退出的程序 **且** 有对偶自证测试(干净输入通过 + 非法输入被拒) | **3 → 7**(附录 B/C 修复后) |
| **L2** 程序未自证 / 模板兑现 | 程序存在但拒绝能力从未被证明,或只有模板靠执行者自觉 | **5 → 3** |
| **L1** 散文兑现 | 只有规则文字 | **10** |
| **L0** 未兑现 | 声称是验证器,但零测试且从不被任何入口执行 | **2 → 0** |

**20 条能力里只有 3 条达到它自己定义的 L3。** 它给别人立的三条核心规矩——门禁必须自证、豁免必须有理由、事故必须三层落地——自己只做到了第一条的一小部分。

---

## Phase 0 — 基座(原始输出)

```
$ ./scripts/selfcheck.sh; echo "EXIT=$?"
=== readiness registry contract + criteria cross-reference
coverage: 98/98 reference criteria
OK: references/readiness-registry.yaml contains a valid readiness registry
PASS readiness registry contract + criteria cross-reference

=== readiness registry parses as standard YAML
standard YAML OK
PASS readiness registry parses as standard YAML

=== skill content invariants
content-checks: 47/47 cases pass
PASS skill content invariants

=== verifier fixture tests
................................................                         [100%]
48 passed in 3.66s
PASS verifier fixture tests

selfcheck PASSED — all gates green
EXIT=0
```

`ls -la references/ scripts/ evals/`:17 个 reference(合计约 450KB)、6 个脚本 + `tests/`、`cases.md` + `content-checks.json`。
`git log --oneline -15 -- skills/eng-init`:最近 15 次提交,含 v3.4.0 落地、iteration-1 KEEP、v3.4.1、dedent 修复、iteration-2 revert。

---

## Phase 1 — 第一性原理推导

### 1.1 根本原因(不从 SKILL.md 自述倒推)

从"AI agent 在仓库里工作"这一事实出发,agent 产生错误改动的根因:

| # | 根因 | 证据 |
|---|---|---|
| R1 | **上下文不可持久**:agent 随时被终止,下次只能靠文件系统恢复;只存在于对话历史的约定等于不存在 | `_archived/ds-harness-mining/02-notes.md:7`(该仓库工程体系的公理) |
| R2 | **散文约定不被遵守**:agent 遵循被强制的门禁远比遵循文档可靠 | `02-notes.md:109`「机械门禁优于散文约定——一切体系的公理」 |
| R3 | **绿灯不等于正确**:测试全绿而产品完全不可用 | `06-incidents.md:16`(178 个绿色单测 + 100% 行覆盖率下 ACP server 一连接就崩) |
| R4 | **无法区分可改与不可改**:生成物、用户自有内容、外部契约看起来都是普通文件 | `05-docs.md`(生成物 `--check` 闭环);`FINAL_REPORT.md` 缺陷 #2(agent 在空目录上被要求"修复") |
| R5 | **agent 会在无证据时宣称完成**:自述输出不是世界状态 | `06-incidents.md` 0003(agent 验证了一个替代服务器,从未探测用户实际在用的端口) |
| R6 | **规则会随时间腐烂**:豁免清单指向已删文件、门禁因 typo 永远为绿 | `01-gates.md` B 节(门禁自证);`06-incidents.md` 0004 |

### 1.2 由根因推导的最小能力集(可证伪断言)

| # | 能力断言(形如"X 存在且会拒绝 Y") | 源自 |
|---|---|---|
| C1 | 仓库事实有唯一持久归属,agent 无需外部记忆即可知道边界 | R1 |
| C2 | 每条机械可查的约定都有一个非零退出的程序拒绝违规 | R2 |
| C3 | 每个门禁都被证明过会拒绝(合成非法输入 + 干净输入对偶) | R2, R6 |
| C4 | 验证走真实入口路径,而非可被绕过的近似路径 | R3 |
| C5 | 生成物与用户自有内容被标识,改动它们会被拒绝 | R4 |
| C6 | 完成声明必须附可复核的外部证据,而非自述 | R5 |
| C7 | 豁免与临时规则携带失效条件,过期即被拒绝 | R6 |
| C8 | 事故教训落到机械层,而不仅是散文层 | R3, R6 |

### 1.3 与 SKILL.md 七层 / 七原则对齐

| 推导能力 | 对应层 | SKILL.md 是否声称覆盖 | 位置 |
|---|---|---|---|
| C1 | Memory | 是 | `SKILL.md:20`(AGENTS.md/CONTEXT.md);Principle #1、#2 |
| C2 | Invariant | 是 | `SKILL.md:21`;Principle #3「Mechanized constraints beat prose」 |
| C3 | Evaluation/GC | 是 | `references/gate-quality-contract.md` § Self-proof;Principle #5「No phantom enforcement」 |
| C4 | Sensorium | 是 | `SKILL.md:24`;Verification Matrix |
| C5 | Permission | 是 | `SKILL.md:23`(generated-path rules);Stage 4 四类 diff |
| C6 | Governance | 是 | Stage 5 证据契约;`agents-md-sections.md`「verify the world, not the self-report」 |
| C7 | Evaluation/GC | 是 | 临时规则移除触发条件;`exemption_registry_hygiene` |
| C8 | Evaluation/GC | 是 | `references/incident-pipeline-templates.md` 三层落地契约 |

**(a) 推导出但未声称覆盖**:无。八条能力 SKILL.md 全部声称覆盖。
**(b) 声称但推导中不必要**:`Protocol` 层的 PR/task 协议与 `Governance` 层的 escalation 规则,在最小能力集里推不出来——它们解决的是**多人/多 agent 协作**问题,不是"单 agent 安全改动"问题。[推断] 属于合理的范围扩展,非过度工程,但应意识到它们的证据基础弱于 C1–C8。
**(c) 一致**:C1–C8 全部。

**Phase 1 结论:eng-init 的目标设定是对的。问题不在它想做什么,在它做到了哪一层。**

---

## Phase 2 + 3 — 落差审计(含独立复核裁定)

判级标准:**L3** = 有非零退出程序 **且** 有对偶自证测试;**L2** = 程序存在但拒绝能力未被证明,或仅模板;**L1** = 仅散文;**L0** = 声称是验证器但零测试且从不执行。

复核者:独立 agent(deepseek-v4-flash,只读工具),只收到判级草稿结论,未收到推导过程。

### 2.1 判级表(★ = 复核推翻我的判定)

| # | 能力 | 我的初判 | **终判** | 证据 |
|---|---|---|---|---|
| 1 | Enforcement Index 每个工具有真实配置或被声明为外部设置 | L3 | ★ **L2** | `check_enforcement_index`(:636-662)**零测试**;且只对"像路径"的 token 验存在,散文工具名不可见,"外部设置"靠关键字正则接受,warn/review-only 行整行跳过 |
| 2 | 渲染产物无 `{{PLACEHOLDER}}` 残留 | L3 | **L3** | `check_no_unresolved`(:373-392)无条件执行;`test_placeholder_scope.py` 对偶齐全 |
| 3 | Verification Matrix 命令解析到真实 target | L3 | ★ **L2** | 机制真实且无条件执行(:710-714),但**无对偶测试**——唯一沾边的是 YAML quoting 测试,测的是别的函数 |
| 4 | CI 有 `if:always()` 聚合 job,skipped 不算通过 | L3 | **L3** | `check_ci_aggregator`(:441-466)+ `test_ci_aggregator.py` 双向齐全 |
| 5 | AGENTS.md 第一节是 Code Canonicality | L3 | **L3** | `check_canonicality_first` + 4 个测试。措辞修正:实际语义是"存在则必须第一",配合 `--require-section` 才构成"永远" |
| 6 | 目标仓库门禁必须自证 | L2 | **L2**(理由修正) | 模板含 `expect_accept`/`expect_reject` 对偶;**我的引证错了**——Stage 5 确实要求执行自测。L2 的真实理由是:装不装看 profile,装后长期有效性靠目标仓库自觉 |
| 7 | 豁免清单每条指向真实目标且有理由 | L1 | **L1** | 全 scripts 目录 grep `exempt` 仅命中测试 docstring,零程序 |
| 8 | 事故教训三层落地 | L1 | **L1** | 全散文/模板 |
| 9 | 条件模块决策可见 | L1 | **L1** | Stage 3 item 12 是对话输出物,headless 下天然不可测 |
| 10 | registry ↔ criteria 交叉一致 | L3 | ★ **L2** | 机制双向且被 selfcheck 执行,但交叉引用分支**零测试**;`test_selfcheck.py` 的红证改的是 `scope` 值,触发的是结构校验,不触达 missing/extra 分支 |

三条推翻我已独立复验:`grep` 确认 `enforcement_index`、`criteria_reference`、matrix target 在 `scripts/tests/` 下的命中**全部位于 docstring/注释**,无真实测试调用。**复核者判定成立。**

### 2.2 复核发现的新增缺口(我遗漏的)

| 能力 | 判级 | 证据 |
|---|---|---|
| CONTEXT.md / 术语治理(Principle #2) | L1 | `check_agents` 只读 AGENTS.md;CONTEXT.md 仅出现在路径白名单,**零内容校验** |
| Baseline / ratchet | L1 | Stage 3 要求 frozen counts + ratchet 表;渲染侧对 `constraints.yaml` baseline **无检查** |
| 关键路径白盒门禁(Principle #4) | L1 | auth/payments/migrations 等要求实施级 review;渲染侧零检查,"Critical Paths" 只出现在 registry 的期望集合里 |
| Strictness profile 一致性(Principle #7) | L1 | Q1.4 必问、禁止静默降级——**无任何机械检查验证渲染产物与所选 profile 一致** |
| 最小测试基线(Sensorium) | L1 | 声称必有 tests/ baseline;matrix 只要能解析到 target 即可,**全 lint 的 matrix 也通过** |
| `score_readiness_report.py` / `validate_readiness_repair.py` | **L0** | 声称是 Audit/Repair 管道验证器;零测试、**不被 selfcheck 调用**——看起来是合格门禁,实际是永不执行的程序 |
| AGENTS.md 活性检查 | L2 | 仅模板,持续活性靠目标仓库 CI 自觉 |
| Stage 3 spec gate(Principle #6) | L1 | 纯流程属性,headless 调用天然绕过 |

### 2.3 自指检验(eng-init 要求别人做的,自己做到了吗)

| 项 | 结论 | 依据 |
|---|---|---|
| **no phantom enforcement** | ✗ **违规** | 两个验证器零测试、从不执行,却列在 SKILL.md reference index 里 |
| **门禁自证对偶** | ✗ **部分违规** | 3/10 达标;`check_enforcement_index`、matrix 解析、registry 交叉引用三条核心检查零测试 |
| **一个门禁一条不变量** | ✗ **违规** | `check_rendered_harness.py` 单脚本捆绑 10+ 不变量,违反自己 `gate-quality-contract.md` 第 1 条;且该单体恰是覆盖最差的 |
| **错误信息协议** | ✗ **违规** | 三个脚本各用一套格式(`FAIL`/`::error::`/`ERROR:`),均无标题行、无 `file:line` 缩进、成功行不报数量;仅退出码合规 |
| **豁免清单卫生** | — 不适用 | eng-init 自身无豁免机制 |
| **生成物 `--check`** | — 不适用 | 自身无生成物。复核者修正我的表述:eng-init **有**自检闭环,只是**闭环有洞**(漏掉两个验证器与 enforcement-index) |
| **事故→规则三层落地** | ✓ **已闭合**(附录 D) | 装了 `docs/postmortem/`,写了 2 篇本会话真实事故,每条 guardrail 都指向存在的机制 |

### 2.4 不变量证据强度

47 条 content-checks,138 个检查:`regex` 80、`contains` 56、`not_regex` **仅 2**、`not_contains` **0**。

- **10/47 条的全部检查都是裸 `contains`**(纯字符串存在性,只能证明"文字还在")
- **否定断言仅 2 条** → 绝大多数不变量**无法捕获"规则被删除后行为回潮"**
- 复核者微调:部分弱证据条目因有端到端红证(`test_selfcheck.py` 真跑 selfcheck 克隆并断红)实际不弱

### 2.5 复核者指出的最大盲点(原样纳入)

> 草稿把"有程序"和"程序被对偶测试证明"混为一谈:它自己在判级标准里把 L3 定义为"程序 + 对偶自证测试",却只在 #2/#4/#5 上核对了测试,在 #1/#3/#10 三条上核对了程序存在就判 L3——这正是 eng-init 自己 `gate-quality-contract.md` § Self-proof 明令禁止的判法("a gate with a typo'd regex that matches nothing is green forever")。更深一层:所有 L3 判级都只验证"测试文件存在",没有一条验证这些测试的拒绝能力是否覆盖了检查器实际暴露的全部路径——最该被审计的,是那个捆绑 10+ 不变量、却对其中一个不变量零测试的 monolith 本身。

这一条我完全接受。**我在 v3.4.0 亲手写下对偶自证规则,两天后审计自己的工作时就违反了它。** 这也说明为什么独立复核是不可省的关卡——自评在同一个盲点上不会发现自己。

---

## 已知债(上一轮遗留,非本次新发现)

1. repair 模式缺可见预览关卡——真实缺口,iteration-2 的散文修复已 DISCARD,需机械手段
2. iteration-1 仍为 **UNCONFIRMED**(未跑对照组)
3. `case-53b` 未判分
4. "ask the user" 期望族在 headless harness 下不可测(oracle 缺陷 #7)

---

## 行动建议(按 收益/成本 排序)

| # | 缺口 | 当前 | 目标 | 成本 | 需跑 case? |
|---|---|---|---|---|---|
| 1 | 两个验证器零测试且不被执行 | **L0** | L3 | 低(写 2 组对偶测试 + 加进 selfcheck) | **否**,读代码即可 |
| 2 | `check_enforcement_index` 零测试 | L2 | L3 | 低(1 组 fixture 对偶测试) | **否** |
| 3 | matrix target 解析零测试 | L2 | L3 | 低 | **否** |
| 4 | registry 交叉引用 missing/extra 零测试 | L2 | L3 | 低 | **否** |
| 5 | 错误信息协议自身不遵守 | 违规 | 合规 | 中(改 3 个脚本输出 + 测试) | **否** |
| 6 | 事故管线未自用(7 个 oracle 缺陷无记录) | 违规 | 合规 | 低(装自己的 `docs/postmortem/` 骨架 + 补写 1 篇) | **否** |
| 7 | 弱不变量(10 条裸 contains、否定断言仅 2) | 弱 | 强 | 中(逐条改成行为断言) | **否** |
| 8 | `check_rendered_harness.py` 捆绑 10+ 不变量 | 违规 | 合规 | 高(拆分单体,回归风险大) | **否**,但需完整 pytest |
| 9 | strictness profile 一致性无机械检查 | L1 | L2/L3 | 中 | 是(行为面) |
| 10 | repair 预览关卡 | L1 | L3 | 高(需设计可验证产物) | **是** |
| 11 | CONTEXT.md 零内容校验 | L1 | L2 | 中 | 否 |

**1–8 全部不需要花钱跑 case**——它们是代码层缺陷,读代码 + 构造反例即可修复和验证。这与上一轮的教训一致:**在代码里的缺陷,读代码就能抓;在行为里的缺陷,才需要花钱跑。**

建议的下一步是 **1–4 打包做一次**(四组对偶测试 + 把两个验证器接进 selfcheck),成本低、直接把自指违规的最严重部分消掉,且完全可由 `pytest` 验证。

---

## 附录 A — 本次审计未修改任何既有文件

```
$ cd /Users/chenwenjie/.agents && git status --short -- skills/eng-init
?? skills/eng-init/docs/2026-08-10-first-principles-audit.md
```

(仅新增本报告)


---

## 附录 B — 建议 1–4 已实施(2026-08-10 当日)

审计的前四项建议(全部"不需要跑 case")已落地并红绿自证:

| 项 | 之前 | 之后 | 证据 |
|---|---|---|---|
| `score_readiness_report.py` | **L0**(零测试、从不执行) | **L3** | `test_readiness_validators.py` 对偶断言 + selfcheck 冒烟门禁 |
| `validate_readiness_repair.py` | **L0** | **L3** | 同上,含 class-D 伪造本地完成的反例与其授权逃生口 |
| `check_enforcement_index` | L2(零测试) | **仍 L2**(见附录 C) | 检查器本身已自证(3 个对偶测试),但它覆盖的范围窄于所声称的能力 |
| Verification Matrix target 解析 | L2(零测试) | **L3** | 2 个对偶测试(真 target 通过 / ghost target 被拒并点名) |
| registry 与 criteria 交叉引用 | L2(零测试) | **L3** | 3 个对偶测试(一致通过 / 少注册被拒 / 多注册被拒) |

**红绿自证**:把两个验证器的拒绝路径分别打断(`if errors:` 改成 `if False:`),`selfcheck.sh` 立即变红;恢复后回绿。新门禁被证明会失败,不是摆设。

**测试数**:48 → **86 passed**。**不变量**:47 → **48**(新增 R42 钉住本次闭合)。

**过程中被自己的测试抓到两处 fixture 错误**(把 repository-scope 判据当成 application-scope;Enforcement Index 表少写一列)——干净态断言的价值在这里直接兑现:只写拒绝测试的话,这两个错误 fixture 会让测试"通过"而实际什么都没验。

**此后的进展**(截至 2026-08-10 收尾):

- 建议 **5**(错误信息协议)**已实施** —— `scripts/gate_output.py` 独占格式,五个 gate 全部改走它
- 建议 **6**(事故管线自用)**已实施** —— 见附录 D
- 建议 **7**(弱不变量)只动 1/10,**有意为之** —— 复查发现"10 条弱证据"本身被高估:`contains` 能捕获删除(主要腐烂形态),只有安全相关的 `pull_request_target` 一条值得收紧
- 建议 **8**(monolith 拆分)**降级不做** —— 它承载的风险已被变异测试释放:100 个分支条条有拒绝证明
- 建议 **9–11**(strictness 一致性、repair 预览关卡、CONTEXT.md 校验)**未动**,均需花钱跑行为验证

计划外新增(不在 1–11 内):`scripts/mutation_sweep.py` 全量变异扫描 + 相应测试,关闭全部存活分支。这是比建议 #7 更强的干预,属执行中自行扩张,如实记录。

**本节曾在 `0c9714d` 被声称"已同步"而实际未改** —— 那次替换的锚点少了一个字,`str.replace` 无声跳过,提交信息里的声明因此为假。见 postmortem 0002 instance 9。


---

## 附录 C — 自审修正:enforcement index 的 L3 是我又一次高估(同一错误的第三次)

附录 B 最初声称 L3 从 3 条升到 8 条。**这个数字是错的,正确是 7 条。**

自审时构造了一个反例并实测:

```
| Rule | Where it lives | Checked by | Level |
|---|---|---|---|
| no secrets committed | gitleaks | pre-commit | block |
| duplicate code | jscpd | CI | block |
| dead code | knip | CI | block |
```

三个 **block 级**工具,仓库里**零配置文件**,`check_rendered_harness.py --require-enforcement-index` 输出 **`PASS`**。原因:`is_path_token` 只认路径形状的 token(带扩展名或斜杠),裸工具名不可见;"Checked by" 列的 `CI` / `pre-commit` 命中外部设置关键字正则,被直接接受。

**我给检查器加了对偶测试,证明的是"路径形状的配置引用必须存在"——比所声称的能力("每个被命名的工具都有真实配置或被声明为外部设置")窄得多。检查器达到了 L3,能力没有。**

这是同一个错误的第三次出现:
1. 初判时把"有程序"当"有证明"(独立复核推翻)
2. 修复后把"程序被证明"当"能力被兑现"(本次自审推翻)

两次都是把**验证对象的边界**放大到了它实际覆盖的范围之外。第一次靠独立复核抓到,第二次靠构造反例实测抓到——**都不是靠读代码或读自己的报告抓到的**。

处理:未修检查器,而是把缺口**钉成一个会说话的测试** `test_enforcement_index_does_not_yet_catch_prose_tool_names`。它断言当前行为(通过),docstring 写明这是已知缺口、为什么没修(基于名字的检测需要工具注册表或启发式,朴素实现会在真实仓库上误报——与 iteration-53 修掉的 ci-aggregator 误报同一失败模式),以及**如果有人补上了检测,这个测试会失败,提示他更新断言并删除该 docstring**。缺口从此在代码里可见,不会随报告一起被遗忘。

另外两条经复验**成立**:
- Verification Matrix target 解析:对不认识的命令形式是**拒绝**(`contains no supported just/make/package-script commands`)而非放行,不存在同类盲区
- registry ↔ criteria 交叉引用:missing/extra 双向覆盖完整,与所声称能力一致


---

## 附录 D — 事故管线自用(建议 6 已实施)

审计发现 eng-init 给别人装事故管线(Q6.9),自己却没有——而它在这次会话里**真的产生了逃逸缺陷**。已用现成材料关闭:

- `docs/postmortem/README.md` — 从自己的模板实例化:三判据(subtle ∧ systemic ∧ costly)、骨架(含强制的"为什么现有防线没拦住")、danger-patterns 的 ≥2 次收敛门槛
- **0001 陈旧字节码** — `.pyc` 让测试套件验证了已从磁盘删除的代码。同长度的一行修改(包括普通 `git revert`)都能触发
- **0002 验证范围被高估四次** — 同一个错误在一次会话里出现四次,每次高一个抽象层级。四次都不是靠读代码或读报告发现的

两篇的 Guardrails 段共命名 6 个机制,**逐条脚本验证过全部存在**——这是契约自己的要求("每条必须指向可指名验证的机制")。三层落地按契约标注:机械层有名有姓,政策层显式写 `not applicable` 加理由,不留裸缺层。

danger-patterns 文档**未创建**:目前只识别出一个缺陷类(高估验证范围),按自己定的门槛需要第二个不同的类才够格。

0002 里最该记住的一句:**"A rule you wrote does not protect you from breaking it."** ——第一次违规发生在规则写下后 48 小时,同一只手。
