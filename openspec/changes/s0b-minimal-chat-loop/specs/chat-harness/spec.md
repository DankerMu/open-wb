# Spec: chat-harness

## ADDED Requirements

### Requirement: HTTP 冒烟对话用例
`smoke/chat.hurl` SHALL 从空 cookie store 独立可运行：登录 → 创建会话（201）→ prompt（202）→ 以 hurl retry 轮询 messages 直到 assistant `status=="done"` → 断言正文匹配 hurl 变量 `content_pattern`、`bash` 步骤数 `>= {{min_bash_steps}}`、无状态非 `done` 的步骤（`$.steps[?(@.status!='done')]` count == 0）、会话 `status=="done"`；再断言他账号访问该会话为 404、`POST /v1/chat/completions` 无 bearer 为 401。`make smoke` SHALL 把它纳入既有 hurl 调用并传 `--variable content_pattern='^你好，这是 WorkBuddy 的第一条流式回复。$' --variable min_bash_steps=1`（即对假上游为精确文本 + 至少一条 bash 步骤）。

#### Scenario: 假上游全绿
- WHEN 服务以 `OMP_BIN` 指向真实 v18.0.10 二进制、上游指向假上游运行，执行 `make smoke`
- THEN 退出 0，所有断言通过

### Requirement: UI 走查对话步骤
Playwright 走查 SHALL 在既有登录/四路由/主题/登出旅程中增加：在 `/` 新建会话、发送固定提示、等待步骤卡出现并变为 done、正文最终等于假上游固定文本、状态 done；**在回合进行中（步骤卡出现后、turn.end 前）刷新页面**，续流后仍得到同一完整正文与 done 状态；回合结束后再次刷新消息列表仍完整；全程零新增浏览器 console error（既有 401 预期计数规则不变）。

#### Scenario: 走查通过
- WHEN 执行 `make ui-walk`
- THEN 退出 0，对话步骤断言全部通过

### Requirement: make 目标与 CI 接线
Makefile SHALL 新增 `omp-fetch`（见 omp-runtime）与 `smoke-live`：后者在 `MODEL_UPSTREAM_BASE_URL` 或 `MODEL_UPSTREAM_API_KEY` 缺失时显式失败并说明，否则对已运行服务只执行 `smoke/chat.hurl` 并传 `--variable content_pattern='^.+$' --variable min_bash_steps=0`（真实上游只断言形状：done + 正文非空）；二者进入 `.PHONY` 与头注释。CI `smoke` 与 `ui-walk` job SHALL 在起服务前执行 `make omp-fetch`（每次下载 + SHA256 校验，不引入 cache action）、启动假上游进程，并以 `OMP_BIN`、`OMP_STATE_DIR`、`SANDBOX_ROOT`、`MODEL_UPSTREAM_BASE_URL=http://127.0.0.1:<port>/v1`、`MODEL_UPSTREAM_API_KEY=fake` 起编译服务；`ci-compiled-server.sh` 的进程组、取消与清理契约 SHALL 不变；真实上游 SHALL 不出现在任何 CI job。

#### Scenario: CI 全绿且不碰真实上游
- WHEN PR 触发 CI
- THEN smoke/ui-walk job 通过且 `all-checks-passed` 绿；workflow 文件中不存在真实上游 URL 或 secret 引用

#### Scenario: smoke-live 门禁
- WHEN 未设置上游 env 执行 `make smoke-live`
- THEN 退出非 0 并打印缺失变量名；设置后对已运行服务执行并按真实回复只断言形状（status done、正文非空、≥0 步骤）

### Requirement: 控制面同步
AGENTS.md 验证矩阵 SHALL 新增 `make omp-fetch`（前置，证据：`var/omp/omp --version` = `omp/18.0.10`）与 `make smoke-live`（手动，证据：退出码 0；真实上游）两行，Directory Map 的 `smoke/` 与 `server/` 描述含对话链路；`constraints.yaml verification.surfaces` SHALL 新增 `omp-fetch` 与 `smoke-live` 两条且 `command/evidence/required_at` 齐全；Makefile 头注释、AGENTS.md、constraints.yaml 三处命令字面 SHALL 一致。

#### Scenario: 三处一致
- WHEN 比对 Makefile 目标集合、AGENTS.md 验证矩阵命令列、constraints.yaml surfaces command
- THEN 三处对 `omp-fetch`、`smoke-live`、`smoke`、`ui-walk` 的命令字面逐字相同
