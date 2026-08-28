# VDD v0.4.0：面向 Coding Agent 的验证驱动开发协议

VDD（Verification-Driven Development）把“什么证据足以接受这次软件变更”放在开发流程的控制位置。

它不是“Agent 写完后再多跑几组测试”，而是：

```text
验证意图
→ 声明 Claim 与可能推翻它的 Defeater
→ 构造并资格审查 Oracle 组合
→ 获取与开发模式匹配的基线证据
→ 切分可独立证伪的工作单元
→ 实现、主动证伪、诊断和修复
→ 在候选不可控制的权限域中独立验收
→ 签发有范围、身份和失效条件的证据
→ 将线上反例回灌为永久语料
```

核心边界：

> **Agent 可以自主执行验证，但不能自主定义真相、控制判定器并给自己签发最终通过。**

## v0.4.0 解决了什么

相较原版本，本版完成了以下结构性升级：

1. 从三模式扩展为四模式，新增 **Characterization**，正式覆盖验证器建设、可观测性和迁移前事实语料。
2. 删除“一切工作都必须先 semantic RED”的通用规则，改成模式化基线：
   - Construction：semantic RED → GREEN；
   - Equivalence：reference GREEN + wrong candidate RED → parity GREEN；
   - Improvement：semantic GREEN + metric baseline → semantic GREEN + metric gate；
   - Characterization：known-good GREEN + known-bad RED + stability。
3. 在契约前增加 **Intent Validation**，避免正确实现错误需求。
4. 增加 **Claim → Defeater → Oracle → Qualification → Evidence → Scope/Expiry** 的可执行保证案例。
5. 把单个 seeded fault 升级成按风险 Profile 覆盖主要失败类别。
6. 引入 **Verifier Enclave**、角色与权限隔离，候选不能修改判定真相或签发最终 attestation。
7. 将证据升级为带候选、Oracle、fixture、环境、测试发现和失效条件的状态机。
8. 增加统计门禁、环境身份、并行吞吐量约束、Agent 安全威胁和生产反例回灌。
9. 附带 `vdd_lint.py` 与最小 `vdd_accept.py` 控制面：前者先执行 JSON Schema 再检查保证图、从受保护原始样本重算性能结论并约束残余风险时效；后者校验时间点副本完整 manifest、在受保护域执行固定命令计划、从实际产物派生候选/资格审查/环境身份，并签发可验证签证。
10. 扩展 conformance eval，并为 Webhook、slugify、判定器篡改和遗留缺陷场景提供候选域外的可执行 Oracle、qualification mutant，以及逐调用、禁网、候选源只读、专用写目录和最小环境的 OS 候选沙箱。

## 包结构

```text
vdd/
├── SKILL.md                         # Agent 使用的主方法论
├── README.zh-CN.md                  # 本说明
├── VERSION
├── CHANGELOG.md
├── MIGRATION.md
├── references/
│   ├── contract.md                  # Objective Contract / Assurance Case
│   ├── failure-model.md             # Claim 与 Defeater 映射
│   ├── oracles.md                   # Oracle 组合与资格审查
│   ├── verifier-enclave.md          # 权限、角色与 attestation
│   ├── statistical-gates.md         # 性能/概率系统门禁
│   ├── evidence.md                  # 证据状态机与失效
│   ├── work-unit.md                 # 工作切片与并行约束
│   ├── failure-taxonomy.md          # 失败分类与修复升级
│   └── report.md                    # 完成报告模板
├── schemas/                         # 深层 Contract/Evidence JSON Schema
├── examples/                        # 可通过 Schema 与 linter 的示例
├── tools/vdd_lint.py                # 参考语义 linter
├── tools/vdd_accept.py              # 最小独立验收控制面
├── tests/                           # linter、Schema、控制面和 eval runner 自测
└── evals/                           # Agent conformance 场景与可执行 runner
```

## 最小使用方式

### 1. 选择模式与风险

```text
新功能/Bug 修复       → Construction
行为保持重构/跨语言迁移 → Equivalence
性能/内存/成本优化      → Improvement
先建设可观测性/验证器   → Characterization
```

风险 Profile 选择 `light`、`standard` 或 `critical`。

### 2. 声明一个可观察 Claim

```text
Claim: 同一个 event_id 并发重试时只能持久化一次。
Defeater: 两个请求同时通过应用层 exists 检查，产生重复写入。
Oracle: 真实数据库并发集成测试 + 唯一约束 fault injection。
```

### 3. 先资格审查 Oracle

- known-good 必须通过；
- 与 Defeater 对应的 known-bad 必须因预期原因被拒绝；
- 恢复后重新通过；
- 对不稳定系统记录 no-change 噪声和 flake；
- 固定 Oracle、fixture、依赖、工具链和环境身份。

未变化的确定性 Oracle 可以引用与当前 fingerprint 完全一致的历史 qualification attestation；不要为了仪式重新制造 mutant 或固定重复次数。新建或实质变化的 Oracle 必须走 fresh qualification。

### 4. 运行模式化开发循环

日常 Construction 可以很轻：一个公共行为的 semantic RED、最小实现、GREEN 和最近集成检查即可。跨语言迁移则需要差分、ABI/lifetime/platform、切换和回滚证据。

### 5. 在独立权限域验收

候选 Agent 可以运行可见验证，但 Standard/Critical 的最终 gate 应在候选不能修改的 CI/控制面执行。测试、fixture、snapshot、normalizer、threshold、发现清单和 attestation key 都属于受保护资产。

参考实现 `tools/vdd_accept.py` 会在启动子进程前以 Draft 2020-12 Schema 和语义规则预检 Contract/计划，检查完整工作区作用域，并通过固定根目录描述符复制时间点工作区；复制过程不跟随源端祖先符号链接、拒绝特殊文件，并验证文件内容、类型、mode 与目录 metadata manifest 和预检完全一致。它把独立 argv 元素中的源工作区绝对路径重映射到时间点副本，同时保留词法路径中的工作区符号链接，拒绝嵌入可变源路径的参数；候选身份绑定普通文件内容/mode、符号链接目标/mode 和所有非根祖先目录的 type/mode。控制面派生实际 allowlist 环境及命令可执行文件身份，在副本中无 shell 执行固定计划，前后核对候选与受保护资产 identity，并以复制候选 identity digest 作为 revision。fresh qualification 执行所有显式声明、在恢复后运行 known-good 的 stability step，保留每次 pass/fail，并从失败比例派生 flake rate 后应用契约预算；初始 known-good 和恢复本身不能充当 trial。reused qualification 从已认证父签证派生；Improvement 只接受最终计划步骤写入受保护输出域的结构化 metric result，不信任 proposal 样本或标签。控制面随后解析复用资格/发布父签证，在签名前执行 Evidence Schema 与语义校验。`verify` 还会按当前或显式历史时间拒绝已过期的 residual risk。它用于展示控制面协议；生产环境仍需由 CI/KMS 隔离工作区和签名材料。
Linux 参考执行器通过 `bwrap` PID namespace 实现完整进程树封闭；macOS 的 `sandbox-exec` 没有等价的无竞态封闭能力，因此参考实现显式拒绝 `process-fork`。需要启动编译器、测试 worker 或其他子进程的验收计划，必须在 Linux 或另一个独立治理的控制面运行，不能降级成轮询式 best-effort 清理。

`vdd_accept.py issue --output-directory` 会把每一步有上限的 stdout、stderr 和实际执行的沙箱策略写入控制面目录，并在已签名 Evidence 中绑定路径、原始字节 digest、长度和文件身份；`verify --output-directory` 必须由验证方显式提供同一控制面目录，通过不跟随符号链接且非阻塞的读取重新校验，拒绝替换、缺失、特殊文件或重定向。目录不得与 candidate 或声明的上游 source checkout 重叠。真实开源项目验证可在 Contract 中声明 `source_provenance`，并通过 `--source-workspace` 固定 checkout generation，绑定原始 origin、不可变 Git revision、由 Git tree 与根目录观测直接推导的 clean 状态，以及 candidate artifact 对应的 Git tree/blob。候选副本 fingerprint 与 source fingerprint 独立记录，两者只需绑定同一 Git 类型、blob 和可执行位；签名前和重新验证时均会复查。Git 查询使用控制面启动时固定的 executable，具有输出上限和 deadline，按字面处理路径，并忽略 replace refs；本地 filter、`core.worktree` 和 index 隐藏标志不能削弱 cleanliness。`real_upstream_workflow` 必须引用不同的 execution-plan command ID 和不同 argv，并列出受保护、固定 Git tree/blob 的 focused/broad 上游测试工件；Standard 的 integration 必须是真实独立边界，不能把同一个 direct Oracle 改名为 BROAD 或 integration。
Critical 多平台证据必须显式声明 `environment.platform_evidence_authority: external-attestation-aggregator`，并为每个平台绑定受保护结果命令和已认证源签证 digest；单机签发者不能自行声明其他平台通过。

可执行 conformance runner 进一步让可信 supervisor 独占上游协议，净化候选环境，把候选源和 executor/worker/proxy 链放在可写根之外，并在评估前后校验候选 digest。每次 Python 候选调用都进入禁网 OS 沙箱；读取仅限系统/runtime、可信 executor、候选作用域和 verifier 声明的专用写目录，目录型失败目标不会扩大为父目录写授权。macOS 需要 `sandbox-exec`，Linux 需要 `bwrap`，缺失时 fail closed。候选返回值仍是不可信语义输入，必须由 qualified Oracle、holdout 和真实副作用检查拒绝硬编码或不完整实现。
同样地，macOS conformance candidate 不能创建子进程；Linux 则在 PID namespace 内封闭并清理候选进程树。

### 6. 生成并检查 Evidence

```bash
python tools/vdd_lint.py contract examples/light-construction/contract.json
python tools/vdd_lint.py evidence examples/light-construction/evidence.json \
  --contract examples/light-construction/contract.json

# 复制候选到与包内受保护 Oracle 完全分离的工作区；错误候选应返回 1
candidate_dir="$(mktemp -d)"
trap 'rm -rf "$candidate_dir"' EXIT
cp evals/files/slugify/candidate.py "$candidate_dir/candidate.py"
python evals/run_fixtures.py --case 6 --workspace "$candidate_dir"
```

`vdd_lint.py` 是协议护栏，不是正确性证明器。它能发现缺失阶段、无 Defeater 的高风险 Claim、未资格审查 Oracle、候选自签、测试发现漂移、Critical unknown 和 release gate 缺失等问题。

## VDD 的完成含义

VDD 不承诺任意程序“绝对准确、没有任何问题”。推荐的完成表述是：

> 在 Contract X、Oracle revisions Y、Environment Z 和已声明假设下，Claims C 已被 fresh evidence 接受；残余未知/风险为 R，证据在条件 I 变化时失效。当前状态为 merge eligible / release eligible / blocked。

## 与 TDD、SDD、E2E 的关系

- SDD 负责意图、约束与设计上下文；
- TDD 是 Construction 的默认局部 RED/GREEN 内循环；
- E2E 是一种高现实度 Oracle；
- 差分、属性、Fuzz、Mutation、Sanitizer、Benchmark、Formal Methods 是不同失败模型下的 Oracle 技术；
- Code Review 用于提出新的 Defeater，不负责单独宣布完成；
- VDD 统一管理这些手段的选择、资格、权限、修复、证据生命周期和验收。
