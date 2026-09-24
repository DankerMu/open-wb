## ADDED Requirements

### Requirement: 已证明 UID 门禁关闭同 uid 降级
After the official uid-isolation job has passed on merged master and joined all-checks-passed, strictness_profile.downgrades SHALL no longer contain s0b_same_uid_credential_exposure. AGENTS.md Enforcement Index SHALL contain the exact uid 隔离 block row pointing to the existing CI uid-isolation/all-checks-passed jobs, with no invented local target. Known blind spots SHALL not claim the closed proc gap. Other downgrade entries and runtime behavior SHALL remain unchanged. This evidence SHALL NOT be described as certification of any user production deployment or unset-OMP_USER isolation.

#### Scenario: 主分支实证后关闭登记
- **GIVEN** merged-master run35978802687 job107565512880 passed the native1test withoutskip and real-omp four-file smoke, and its aggregate passed
- **WHEN** the registry/docs/oracle closure lands atomically
- **THEN** the active same-UID registration is absent, exact enforcement row is active at block, all other downgrade records remain and guardrails pass

#### Scenario: 关闭合同不可伪造或回退
- **WHEN** a candidate reintroduces the closed active registration, omits/weakens/duplicates the enforcement row, or substitutes a comment/fence/foreign owner for active ownership
- **THEN** the source-derived oracle rejects the invalid control plane, while the valid and restored baseline passes
