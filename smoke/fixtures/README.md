# smoke/fixtures

本目录存放 HTTP 冒烟（`make smoke`）与 UI 走查（`make ui-walk`）使用的固定夹具。本 README 放在 `sandbox/` 之外，不会随夹具被复制进沙箱。

## 目录

- `sandbox/u1/smoke-fixture/`：工作空间夹具，恰好三个文件。CI 脚本（`.github/scripts/ci-compiled-server.sh`、`.github/scripts/ci-uid-isolation.sh`）在启动服务前执行 `cp -R smoke/fixtures/sandbox/u1/. "$SANDBOX_ROOT/u1/"`；本地运行时由调用方自行复制（见 `Makefile` 的 `smoke` 头注释）。
- `sandbox/u1/ui-walk-skills/.omp/skills/walk-brief/SKILL.md`：带一个项目 skill 的工作空间夹具（#814），与上一项同一条 `cp -R` 复制进沙箱。根 `.gitignore` 忽略 `.omp/`，本目录靠其后的例外规则 `!smoke/fixtures/sandbox/**/.omp/` 入库。
- `static/`：smoke job 的 `STATIC_ROOT`（`public.hurl` 深链字节比对用），与工作空间夹具无关。

## 三个夹具文件

| 文件 | 用途 | 内容要点 |
| --- | --- | --- |
| `readme.md` | Markdown 渲染与源码视图 | 首行固定为 `# smoke-fixture`（唯一的一级标题），另含二级标题、无序列表、代码块与表格 |
| `notes.csv` | CSV 表格预览 | 表头 `name,value` 加 4 行数据，首两行固定为 `alpha,1`、`beta,2`，以换行结尾 |
| `logo.png` | 图片预览 | 256×256 PNG，白底、品牌色实心圆、中心白色菱形 |

## 消费方

- `smoke/files.hurl`：`tree` 断言三个文件名存在；`file?path=…` 用 `file,fixtures/sandbox/u1/smoke-fixture/…;` 自引用比对字节，并断言 Content-Type（`readme.md`、`notes.csv` 为 `text/plain; charset=utf-8`，`logo.png` 为 `image/png`）。字节比对随夹具内容自动跟随，不含长度或大小字面量。
- `web/e2e/ui-walk.spec.ts` 的 `walkFiles`：断言 readme 渲染出一级标题 `smoke-fixture`、源码视图第一行为 `# smoke-fixture`；CSV 预览恰好 5 行（表头加 4 行数据），含 `alpha 1`、`beta 2` 与说明 `共 4 行 · 大文件仅预览前若干行`；`logo.png` 预览图的 `naturalWidth` 与 `naturalHeight` 均为 256。
- `scripts/test-ci-harness.sh`：用 `cmp -s` 比对源夹具与复制目标，与内容无关。
- `web/e2e/ui-walk-sessions.spec.ts` 的 `step2ProjectSkill`：欢迎态在 composer 页脚选中工作空间 `ui-walk-skills` 后输入 `/`，候选面板恰三项，第三项的 label 为 `walk-brief`、标注 `项目`、描述为 `SKILL.md` 的 `description`。

## 项目 skill 夹具

`ui-walk-skills/.omp/skills/walk-brief/SKILL.md` 的 frontmatter 固定为 `name: walk-brief` 与一行 `description`。它只影响 `GET /api/commands?workspaceId=<ui-walk-skills 的 id>`：不带 `workspaceId` 的目录（`smoke/session-meta.hurl` 断言恰两条内建）与其它工作空间的目录都不含它，所以 owner 根 `u1/` 与 `smoke-fixture/`、`ui-walk-sessions/`、`smoke-sessions/` 之下不要放 `.omp`。

## 替换夹具时要同步检查

- `web/e2e/ui-walk.spec.ts` 的 `walkFiles`：readme 标题与源码首行、CSV 行数与说明文案、图片尺寸。
- `smoke/files.hurl`：目前没有大小字面量；以后若增加长度或大小断言，替换夹具时要一起更新。
- `git ls-files smoke/fixtures/sandbox` 必须恰好列出四个文件：`smoke-fixture/` 的三个夹具文件与 `ui-walk-skills/.omp/skills/walk-brief/SKILL.md`；CI 不检查多余文件，新增文件不要放进 `sandbox/`。
- 改 `walk-brief` 的名字或描述时同步 `web/e2e/ui-walk-sessions.spec.ts` 的 `SKILL_LABEL` 与 `SKILL_DESCRIPTION`。

## `logo.png` 的生成方式

用 Python 3 标准库（`zlib`、`struct`）逐像素写出 PNG，生成脚本是一次性的，不入库。参数：

- 格式：256×256，8-bit RGB（color type 2），非隔行；每行 filter 0，zlib 压缩；只含 IHDR / IDAT / IEND 三个块。
- 逐像素规则（`x`、`y` 取 0..255，中心为 (128, 128)）：
  1. 若 `|x-128| + |y-128| <= 48`，取白色 `#ffffff`（菱形）；
  2. 否则若 `(x-128)^2 + (y-128)^2 <= 100^2`，取品牌色 `#00c29a`（圆）；
  3. 否则取白色 `#ffffff`。
- 生成后用 `file` 核对，应输出 `PNG image data, 256 x 256, 8-bit/color RGB, non-interlaced`。

颜色取自演示原型 `resource/workbuddy-live-demo.html` 中设计 token `--wb-palette-brand-8` 的浅色值。图形是本仓库自绘的几何图形，不是上游品牌资产（见 `ATTRIBUTION.md` §4）。
