## MODIFIED Requirements

### Requirement: 对话验证控制面同步
AGENTS.md、constraints.yaml 与 Makefile 页头 SHALL 同步对话验证职责：omp-fetch 是官方 v18.0.10 二进制供给 prerequisite，evidence 为版本与 SHA 校验；smoke-live 是 caller-owned 真实上游手动验证，evidence 为非空 done 回复与退出码，Enforcement Index 为 review-only，不能作为已运行真实上游的声明。原 smoke/ui-walk SHALL 保持 block。constraints verification.surfaces SHALL 从八个增为十个。S0b 同 uid 凭证风险的登记 SHALL 按 ADR0010 在正式 merged-master uid-isolation job 与 aggregate 全绿后关闭；active strictness_profile.downgrades 不再含 s0b_same_uid_credential_exposure，其他三条登记保持不变，AGENTS.md 以 uid 隔离 block 行指向正式CI门禁。环境白名单本身仍不证明隔离，且此关闭不宣称任意生产部署已验收。

#### Scenario: 新增镜像完整且旧行为不变
- **WHEN** 执行 source-derived CI contract oracle 与 make test-guardrails
- **THEN** 四条命令的 matrix、constraints 与 Make targets 一致，新增条目有 command/evidence/required_at，server/ 与 smoke/ 目录描述包含对话，页头无延后 #107
- **AND** 不修改 Make recipes、CI workflow、产品代码、门禁阈值或既有 smoke/ui-walk block

#### Scenario: 文档伪镜像被拒绝
- **WHEN** 独立删除或改错新增条目、等级、页头职责，或重新引入已关闭的 same-uid downgrade，或只在注释/其他 owner 中放置替代文本，或添加任一四个目标的 spaced duplicate
- **THEN** oracle 非零，恢复合法源后通过；不把源码中仍有同名关键词当作有效镜像
