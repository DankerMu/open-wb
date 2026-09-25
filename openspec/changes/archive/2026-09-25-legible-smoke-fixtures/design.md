# Design: legible-smoke-fixtures（#296）

Fixture level：expanded（父 tasks 组 6 声明；review priority mechanical）。

Risk packs：
- File IO / path safety / overwrite：README 位置不能进入沙箱复制面。
- Schema / columns / units / field names：csv 表头与行数、png 尺寸与格式。
- Legacy compatibility：readme 首行、csv 首两行与三个文件名不变，files.hurl 与复制 oracle 不改仍绿。
- Release / packaging / dependency compatibility：PNG 须能被 Chromium 真实解码。

Governing invariant：夹具 `smoke/fixtures/sandbox/u1/smoke-fixture/` 恰好三个文件（`readme.md`、`notes.csv`、`logo.png`）。三个 oracle 都以这份夹具为输入：smoke（`files.hurl` 自引用字节）、ui-walk（文案与尺寸）、test-ci-harness（`cmp -s` 复制）。夹具内容与 ui-walk 断言必须在同一个 PR 中一起变化。

Sibling surfaces（消费夹具的全部位置，均已 `git grep` 确认）：
- `.github/scripts/ci-compiled-server.sh:16` 与 `.github/scripts/ci-uid-isolation.sh:93`：`cp -R smoke/fixtures/sandbox/u1/. "$SANDBOX_ROOT/u1/"`。README 放在 `smoke/fixtures/`，在 `sandbox/` 之外，不会被复制。
- `.github/workflows/ci.yml:85,139`：`STATIC_ROOT` 指向 `smoke/fixtures/static`，与 README 无关。
- `smoke/files.hurl:36-40`（tree 含三文件）、`:80-100`（三个 `file,fixtures/…;` 自引用字节比对与 Content-Type）：只断言文件名与类型，没有大小字面量，不需要改。
- `scripts/test-ci-harness.sh:448-451`：用 `cmp -s` 比对源与复制目标，与内容无关。
- `web/e2e/ui-walk.spec.ts:418-470`（`walkFiles` 与 `expectRootFileButtons`）：readme heading 与源码首行不变；csv 行数与说明要改；logo 断言新增。
- 服务端测试（`server/test/workspace-*.test.ts`）各自在临时目录造文件，不读这份夹具。
- `openspec/specs/files-web/spec.md` 中出现的 `logo.png`（90492109 B）是 jsdom 夹具，与本夹具无关。

Change surface：
- 修改：`smoke/fixtures/sandbox/u1/smoke-fixture/{readme.md,notes.csv,logo.png}`、`web/e2e/ui-walk.spec.ts`。
- 新增：`smoke/fixtures/README.md`。
- 不改：`smoke/*.hurl`、`scripts/**`、`.github/**`、`server/**`、`web/src/**`、`web/test/**`、`Makefile`、`app-reference/**`。

Must preserve：
- 三个文件名、`readme.md` 首行 `# smoke-fixture`、`notes.csv` 的前三行 `name,value` / `alpha,1` / `beta,2`。
- Content-Type 不变：readme、csv 为 `text/plain; charset=utf-8`，png 为 `image/png`（服务端按扩展名判定，见 `files.hurl:84,91,98`）。
- ui-walk 的既有断言：
  - rendered heading level 1 `smoke-fixture` 仍唯一。新 readme 只有一个 `# ` 标题，其余是 `## `。
  - 源码视图第一行两个 cell 分别为 `1` 和 `# smoke-fixture`。
  - `alpha 1`、`beta 2` 两行可见。
- `web/e2e/ui-walk.spec.ts` ≤ 800 行（size-guard，当前 742 行）。

Must add/change：
- `readme.md`（UTF-8，LF，以换行结尾，逐字如下）：
  ````markdown
  # smoke-fixture

  冒烟（`make smoke`）与 UI 走查（`make ui-walk`）共用的固定工作空间。

  ## 文件

  - `readme.md`：Markdown 渲染与源码视图
  - `notes.csv`：CSV 表格预览
  - `logo.png`：图片预览（256×256）

  ## 本地运行

  ```bash
  make smoke
  make ui-walk
  ```

  ## 数据摘要

  | 名称 | 值 |
  | --- | --- |
  | alpha | 1 |
  | beta | 2 |
  ````
  外层四个反引号只是 design 的包裹，不属于文件内容。文件从 `# smoke-fixture` 开始，到 `| beta | 2 |` 加一个换行结束。
- `notes.csv`（LF，以换行结尾，逐字）：
  ```
  name,value
  alpha,1
  beta,2
  gamma,3
  delta,4
  ```
- `logo.png` 由一次性脚本生成，脚本放 scratchpad，不入库：
  - 格式：256×256，8-bit RGB（color type 2），非隔行，每行 filter 0，zlib 压缩，只含 IHDR / IDAT / IEND。
  - 逐像素规则（x、y 取 0..255，中心 (128,128)）：
    - 若 `|x-128| + |y-128| <= 48` → 白 `#ffffff`（菱形）；
    - 否则若 `(x-128)^2 + (y-128)^2 <= 100^2` → 品牌色 `#00c29a`（圆）；
    - 否则 → 白 `#ffffff`。
  - 生成后用 `file` 命令核对，应输出 `PNG image data, 256 x 256, 8-bit/color RGB, non-interlaced`。
- `smoke/fixtures/README.md`：
  - 三文件的用途与消费方：files.hurl 字节比对、ui-walk 文案与尺寸、test-ci-harness 复制 oracle。
  - 替换夹具时要同步检查的断言：`web/e2e/ui-walk.spec.ts` 的 `walkFiles`；如果 `files.hurl` 以后加了大小字面量，也要同步。
  - `logo.png` 的生成方式：Python 3 标准库（`zlib`、`struct`）逐像素写 PNG，参数同上。写明颜色取自 demo token `--wb-palette-brand-8` 的浅色值，是自绘几何图形、不是上游品牌资产（引 ATTRIBUTION.md §4）；写明生成脚本不入库。
  - 写明 `static/` 目录是 smoke job 的 `STATIC_ROOT`，与本夹具无关。
  - 中文，不含任何 IP、用户名、密钥或供应商名。
- `web/e2e/ui-walk.spec.ts` 中的 `walkFiles`：
  - `:438` 的 `toHaveCount(3)` 改为 `toHaveCount(5)`；`:441` 的文案改为 `共 4 行 · 大文件仅预览前若干行`。
  - 在 csv 断言之后、`新建` 之前新增：
    ```ts
    await tree.getByRole("button", { name: "logo.png", exact: true }).click();
    const logo = preview.getByRole("img", { name: "logo.png", exact: true });
    await expect(logo).toBeVisible();
    await expect.poll(() => logo.evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight])).toEqual([256, 256]);
    ```
    `preview.tsx:159-162` 把图片渲染为 `<img alt={name}>`，其中 `name` 是文件名。`expect.poll` 用来等待解码完成。

## Required evidence
每项单独注入并运行对应命令，确认变红后回退：
1. `notes.csv` 删去最后一行（剩 3 行数据）→ `ci-compiled-server.sh ui-walk` 红（`row` 计数与 `共 4 行`）。
2. `logo.png` 换回原来的 1×1 PNG（`git show fa3ec8b:smoke/fixtures/sandbox/u1/smoke-fixture/logo.png`）→ ui-walk 红（尺寸断言）。
3. `readme.md` 首行改为 `# smoke fixture` → ui-walk 红（heading 与源码首行）。
4. ui-walk 的 `toHaveCount(5)` 改回 3，夹具不动 → ui-walk 红（证明新断言绑定新夹具）。
5. 把 README 移进 `sandbox/u1/`（`git mv smoke/fixtures/README.md smoke/fixtures/sandbox/u1/README.md`）→ Test plan 的 `git ls-files smoke/fixtures/sandbox` 检查多出一行，即为红。CI 的 ui-walk、test-guardrails、files.hurl 都不检查多余文件（`test-ci-harness.sh:450-451` 只 `cmp` 三个文件；`expectRootFileButtons` 只断言三个按钮可见；`files.hurl:38-40` 只断言 `exists`）。所以 README 不进沙箱只靠目录位置和这条检查保证。
6. files.hurl 自引用字节比对。`ci-compiled-server.sh` 在同一次调用里先复制、再启动、再跑 smoke，构造不出不一致，所以唯一做法如下：
   1. 按 `ci.yml` smoke job 的环境变量（端口、`RUNNER_TEMP` 用 mktemp）手动启动编译后的服务：`npm run start --workspace server`，或者 helper 实际执行的同一条启动命令。
   2. `cp -R smoke/fixtures/sandbox/u1/. "$SANDBOX_ROOT/u1/"`。
   3. 把 `$SANDBOX_ROOT/u1/smoke-fixture/notes.csv` 改一个字节（例如把末尾的 `4` 改为 `5`）。
   4. 执行 `hurl --test --variable base_url=http://127.0.0.1:<port> smoke/files.hurl`，预期只有 `files.hurl` 中 `file,fixtures/sandbox/u1/smoke-fixture/notes.csv;` 这条断言失败。
   5. 把该文件恢复成仓库版本后重跑同一条命令，应当通过。最后停掉服务。

Review-round 补充（orchestrator 验证，PR #377 评论记录）：注入 1、3 分别停在第一条失败断言，因此另补两项，只改断言或只改夹具中的一处：
- 1b：夹具不动，把 `:441` 的文案改为 `共 3 行 · 大文件仅预览前若干行` → ui-walk exit 2，失败在 `:441`（元素不存在）。
- 3b：在夹具 `readme.md` 前加一个空行（渲染出的 h1 仍在）→ ui-walk exit 2，失败在 `:433`（期望 `# smoke-fixture`，实际 `" "`）。
两项回退后都已用 `cmp` 核对一致。

## Test plan / verification
- `make check` exit 0。注意：它的 naming-guard 只扫 `server/web/kbservice/scripts`（`Makefile:34`），size-guard 只看 `.ts/.tsx/.py`。
- `bash scripts/naming-guard.sh smoke/fixtures/README.md smoke/fixtures/sandbox/u1/smoke-fixture/*` exit 0（新文件的命名检查）。
- `git ls-files smoke/fixtures/sandbox` 恰好输出三行：`smoke/fixtures/sandbox/u1/smoke-fixture/logo.png`、`…/notes.csv`、`…/readme.md`。
- `make test-guardrails` exit 0。
- `npm run build --workspace web` 后，本地两条命令各 exit 0（环境变量与 `ci.yml` 一致，端口与 RUNNER_TEMP 用 mktemp）：
  - `HOST=127.0.0.1 PORT=18016 SMOKE_BASE_URL=http://127.0.0.1:18016 … bash .github/scripts/ci-compiled-server.sh smoke`（需要 `npm run build --workspace server`，并确认本机 hurl 版本可用；如版本不符，在报告中写明）；
  - `… bash .github/scripts/ci-compiled-server.sh ui-walk`。
- `file smoke/fixtures/sandbox/u1/smoke-fixture/logo.png` 输出 256×256 RGB。

Seams under test：夹具文件 ↔ ui-walk `walkFiles` 断言 ↔ files.hurl 自引用 ↔ CI 复制脚本。

Review focus：readme 逐字内容与首行；csv 行数与文案；PNG 合法性与尺寸断言的等待方式；README 位置不进入沙箱。

## Not yet specified
- ui-shots 截图（6.3a/b）会用到这份夹具的视觉效果，本刀不产截图。

## Implementation deviations
- `walkFiles` 新增的 `expect.poll(...)` 按 Biome formatter 要求折成三行（`await expect` / `.poll(...)` / `.toEqual([256, 256])`），语义与上文逐字片段一致。
- 注入 5：`smoke/fixtures/README.md` 尚未被跟踪，`git mv` 之前先执行了 `git add smoke/fixtures/README.md`。回退后 README 保持已暂存（`A`），`git ls-files smoke/fixtures/sandbox` 恰三行。
- 注入 1：失败点是 `ui-walk.spec.ts:438` 的 `toHaveCount(5)`（实得 4），旅程在此中止，没有走到 `共 4 行` 文案断言。这一项注入由行数断言单独证红。
- 注入 3：失败点是渲染视图的一级标题断言（`ui-walk.spec.ts:429`），旅程在此中止，没有走到源码首行断言。这一项注入由标题断言单独证红。
