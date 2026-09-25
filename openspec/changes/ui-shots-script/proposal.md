# Proposal: ui-shots-script（#297）

## Why
父 change `s1e-frontend-parity` tasks 6.3a。S1e 的 demo 一致性验收 = 截图对 + 人工清单签收（父 design 决策 11），目前没有任何产出截图对的工具：评审者只能手工开两个窗口对照。父 spec demo-parity-acceptance「ui-shots 截图对产物」定义了脚本形状；本刀交付脚本与 npm 入口，Make/控制面留给 6.3b（#298）。

## What Changes
- 新增 `web/e2e/ui-shots.mjs`：Playwright chromium 脚本（不是 test），六格（`1440×900`/`1024×768`/`390×844` × `light`/`dark`）× 五个固定态（`login-default`/`chat-welcome`/`chat-done`/`files-readme`/`settings-default`）× 两源（app/demo）= 60 张 PNG + `index.html` 对照表。
- `web/package.json` scripts 增 `"ui-shots": "node e2e/ui-shots.mjs"`。
- app 侧只走 caller 已启动的服务（`UI_SHOTS_BASE_URL`，缺省 `http://127.0.0.1:3000`）与真实 REST；demo 侧 `file://` 打开 `resource/workbuddy-live-demo.html`。
- 每张 app 截图前断横向溢出与无 workspace `root` 绝对路径；任一失败非零且保留已产出文件。

## Non-goals
- `Makefile` `ui-shots` 目标、`AGENTS.md`、`constraints.yaml`、`scripts/test-ci-harness.sh`（6.3b #298）。
- CI job（父 design 决策 11：不进 CI）；像素 diff；验收清单（6.4 #301）。
- 产品代码：截图暴露的呈现差距记入 6.4 清单，不在本刀修。

## Capabilities
- ADDED `demo-parity-acceptance`：「ui-shots 截图对产物」的脚本部分（npm 入口；`make ui-shots` 条款由 6.3b 以 MODIFIED 补上）。

## Impact
- Error handling / partial outputs：逐张继续、汇总错误、非零退出；`index.html` 总会写出，缺失格标注。
- 不写 caller 的 DB/沙箱以外的状态；唯一写入是经真实 REST 在缺失时创建 `smoke-fixture` 工作空间与一个 `chat-done` 会话（与 ui-walk 同类行为）。
