# Tasks: ui-shots-control-plane（#298）

## 1. Fixture
- [x] 1.1 独立 fixture 审核 pass（r1 revise：1 P1 + 2 P2 已修；r2 pass + 4 Note 吸收，报告 `.workplans/298/review/fixture-r{1,2}.md`）；`openspec validate ui-shots-control-plane --strict --no-interactive` exit 0。

## 2. Implementation
- [x] 2.1 Makefile / AGENTS.md / constraints.yaml 按 D1–D5。
- [x] 2.2 `scripts/test-ci-harness.sh` 按 D6，新增 D7 mutation 用例；`make test-guardrails` 全 PASS。
- [x] 2.3 `make ui-shots` 实跑证据（Required evidence 3–4）。

## 3. Verification
- [x] 3.1 `make check` exit 0；`make test-guardrails` exit 0。
- [x] 3.2 archive PR（PR #393 merge 88120fd；review r1 not-clean（correctness P2 oracle 绕过）→ fix pass 1 0abe499 → r2 clean，残余 P2 记入 #392；首轮 CI ui-walk flake 登记 #395）：verification-harness「CI 接线与控制面同步」、demo-parity-acceptance「ui-shots 截图对产物」「控制面同步」晋升；父 delta 对应块与晋升文本一致（或改为与晋升相同），并同步父 `tasks.md` 6.3b 与父 `design.md` 决策 14 中「`UI_SHOTS_OUT` 仅 export」为冻结后 export；勾选父 tasks 6.3b；关闭 #298。

## Risk pack mapping
- Selected Public API / CLI / script entry：新 target `ui-shots` 与 env。证据：Required evidence 3–4、D7 配方/PHONY mutation。
- Selected Config / project setup：Makefile 赋值/export、constraints.yaml。证据：D7 赋值/export/constraints mutation。
- Not selected File IO / path safety / overwrite：输出目录由脚本处理（#297）。
- Not selected Schema / columns / units / field names：无。
- Not selected Auth / permissions / secrets：不触及凭证；`--silent` 减少本机路径外泄。
- Not selected Concurrency / shared state / ordering：无。
- Not selected Resource limits / large input / discovery：无。
- Selected Legacy compatibility / examples：既有 surface/target/mutation 全保持。证据：Required evidence 1（FAIL 0）。
- Not selected Error handling / rollback / partial outputs：退出码透传脚本。
- Not selected Release / packaging / dependency compatibility：无。
- Selected Documentation / migration notes：AGENTS.md 两行镜像。证据：D7 AGENTS mutation。
