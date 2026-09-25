# Proposal: legible-smoke-fixtures（#296）

## Why
这是 S1e 组 6 的 6.2，没有依赖。现有夹具（`smoke/fixtures/sandbox/u1/smoke-fixture/`）三份文件都在功能上成立，但肉眼几乎看不出东西：
- `readme.md` 只有一行 `# smoke-fixture`（16 B）；
- `notes.csv` 只有表头加 2 行（26 B）；
- `logo.png` 是 1×1 灰度 PNG（67 B）。

所以在 `/files` 里截图或人工验收时，看不出 Markdown 渲染、表格预览、图片预览的实际效果。审查报告 `docs/reviews/2026-09-24-demo-parity-audit.md` §4 与父 design 的 D13 已拍板：
- 换成 256×256 品牌色几何图形；
- readme 用多段 Markdown；
- csv 用 4 行；
- 新增 `smoke/fixtures/README.md`。

## What Changes
- **夹具替换**（`smoke/fixtures/sandbox/u1/smoke-fixture/`）：
  - `readme.md`：首行仍为 `# smoke-fixture`，另加二级标题、无序列表、代码块与表格，逐字内容见 design。
  - `notes.csv`：`name,value` 加 4 行，首两行仍为 `alpha,1`、`beta,2`，文件以换行结尾。
  - `logo.png`：256×256 8-bit RGB 非隔行 PNG。白底，品牌色 `#00c29a` 实心圆，中心为白色菱形。用一次性 Python 标准库脚本生成，脚本不入库。
- **新 `smoke/fixtures/README.md`**：说明三文件的用途、谁在消费它们、`logo.png` 的生成参数与方法，以及替换夹具时要同步检查的断言面。
- **`web/e2e/ui-walk.spec.ts`**：
  - csv 的 `row` 计数由 3 改为 5，行数说明由 `共 2 行` 改为 `共 4 行 · 大文件仅预览前若干行`；
  - 新增一步：点击 `logo.png` 后，预览图 `img[alt=logo.png]` 的 `naturalWidth` 与 `naturalHeight` 都应为 256。
- **`smoke/files.hurl` 不改**：它用 `file,…;` 自引用做字节比对，没有长度或大小字面断言。
- **`scripts/test-ci-harness.sh` 不改**：它的夹具复制 oracle 是 `cmp -s`，与文件内容无关。

## Non-goals
- 双 project（6.1）与 ui-shots（6.3a/b）。
- 修改 `files.hurl` 的断言结构。
- 在 `demo-parity-acceptance` capability 中晋升「肉眼可辨夹具」。它随父 change 最终归档一起 ADDED。本刀先把夹具契约晋升到它真正的所有者 `files-harness`。

## Capabilities
- MODIFIED `files-harness`：
  - Requirement「沙箱夹具与 files.hurl」：夹具描述从"一个 `# ` 标题、csv 表头 + 2 行、最小合法 PNG"改为肉眼可辨版本，并写明 README 与自引用比对。
  - Requirement「走查 /files 步骤」："plus two data rows" 改为五行加 `共 4 行` 说明，并加上 logo 的 256×256 解码断言；新增 Scenario「肉眼可辨夹具的预览」。

## Impact
- 修改：`smoke/fixtures/sandbox/u1/smoke-fixture/{readme.md,notes.csv,logo.png}`、`web/e2e/ui-walk.spec.ts`。
- 新增：`smoke/fixtures/README.md`。
- 不改 `server/**`、`web/src/**`、`web/test/**`、`smoke/*.hurl`、`scripts/**`、`.github/**`、`app-reference/**`。

## 与 oracle 偏差留痕
- demo 没有夹具的概念，本刀只对齐"预览区能看出效果"这一验收目的。`logo.png` 是自绘几何图形，没有复用上游品牌图形（ATTRIBUTION.md §4）；颜色取自 demo token `--wb-palette-brand-8` 的浅色值。

## Risk triage
Issue type: test（验证夹具，mechanical）
Fixture level: expanded
Upstream suggested level: expanded（同意：夹具同时是 smoke 字节 oracle、ui-walk 文案 oracle、test-ci-harness 复制 oracle 的输入）
Blast radius:
- 三个 CI job 消费这份夹具：smoke、ui-walk、uid-isolation（经 `.github/scripts/ci-compiled-server.sh:16` 与 `ci-uid-isolation.sh:93` 的 `cp -R`）。
- `scripts/test-ci-harness.sh:448-451` 的 `cmp -s` 复制 oracle 也读它。
- ui-walk 的 readme/csv 断言与夹具内容逐字绑定。
Width exception: multi-path - 夹具是 smoke 字节 oracle 与 ui-walk 文案 oracle 的共同输入，替换必须让两面在同一个 PR 里都绿。
Selected risk packs:
- File IO / path safety / overwrite：新增的 README 必须留在 `sandbox/` 之外，不能被 `cp -R smoke/fixtures/sandbox/u1/.` 复制进沙箱。
- Schema / columns / units / field names：csv 表头与行、png 尺寸。
- Legacy compatibility / examples：readme 首行、csv 首两行、三个文件名不变；files.hurl 与复制 oracle 不改仍绿。
- Release / packaging / dependency compatibility：图片需要浏览器真实解码，PNG 必须是合法的 8-bit RGB。
Evidence floor:
- `make check` exit 0；显式对新文件跑 `bash scripts/naming-guard.sh` exit 0；`git ls-files smoke/fixtures/sandbox` 恰为三个夹具文件；
- `make test-guardrails` exit 0；
- 本地 `ci-compiled-server.sh ui-walk` 与 `ci-compiled-server.sh smoke`（CI 环境变量）各 exit 0；
- 反向注入各红；
- CI smoke、ui-walk、uid-isolation 均绿。
