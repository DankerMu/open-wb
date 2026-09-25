# Proposal: files-entry-meta（#293）

## Why
S1e 组 5 的 5.2，依赖 1.1（#275 `Icon`），已合入。审查报告 `docs/reviews/2026-09-24-demo-parity-audit.md` §4 把文件树条目列为实现偏差：
- 目录与文件都用手写的单一 svg，没有按扩展名区分（`web/src/features/files/tree.tsx:142-144,193-200`）。
- 行尾没有大小。
- 预览头没有文件类型图标。
- 大小格式化只在 `preview.tsx:28-36` 的私有 `formatByteSize` 里。它把 KB 取整，与 demo/父 delta 的"一位小数"不一致，也不支持 GB。

父 design 决策 9（D9）已拍板：`fileIcon(name)`/`formatSize(bytes)` 为纯函数，`formatSize` 替换 `formatByteSize`，作为单一来源。

## What Changes
- 新 `web/src/features/files/file-meta.ts`：
  - `fileIcon(name: string): IconName`：取最后一个 `.` 之后的扩展名，不区分大小写。
    - `png|jpg|jpeg` → `image`
    - `zip|tar|gz` → `archive`
    - `csv` → `table`
    - `md|txt|log` → `file-text`
    - `json|js|ts|tsx|html` → `file-code`
    - 其它（含无扩展名、以 `.` 结尾）→ `file`；扩展名规则与既有可预览判断相同（最后一个 `.` 之后）
  - `formatSize(bytes: number): string`：
    - `bytes < 1024` → `${bytes} B`
    - 否则依次以 1024 进位到 KB/MB/GB，保留一位小数（`toFixed(1)`）。
    - 选单位的规则：从 KB 起，若一位小数舍入后的值 ≥ 1024 且未到 GB，则进位到下一单位；GB 封顶（`1048575` → `1.0 MB`，不出现 `1024.0 KB`）。
- `tree.tsx`：
  - 目录行（含根行）的第二个手写 svg 换成 `Icon folder`；折叠箭头 svg 不动。根行的 `shield` 与空间名属 5.1b #292。
  - 文件行的手写 svg 换成 `Icon name={fileIcon(entry.name)}`，名称后追加 `<span className="files-tree-size" aria-hidden="true">{formatSize(entry.size)}</span>`。按钮可访问名保持恰为文件名：jsdom 与 ui-walk（`web/e2e/ui-walk.spec.ts:425,434,466-468`）都按 `exact` 名定位。
- `preview.tsx`：
  - 删除 `formatByteSize`，预览头大小改用 `formatSize`。
  - 预览头在路径前加 `Icon name={fileIcon(name)}`。
  - 截断提示 `预览已截断（原始大小 N B）` 保持字节原值，不改：它属 `文件预览纯组件` 契约，既有测试钉住 `12345 B`。
- `files.css`：`.files-tree-size`（行尾右对齐、`--wb-text-tertiary`、`flex: none`、不换行）；名称保持 `overflow-wrap:anywhere`（截断属 #294）；图标外包 span 承接既有 `.files-tree-glyph`（`Icon` 不收 `className`）；预览头图标对齐。只用语义 token，来源注释 demo:694-706。
- 测试：新 `web/test/file-meta.test.ts`（表驱动）；`files-page.test.tsx` 新增树条目/预览头用例，并改写 `:102-106` 的行名列举（见 design）。

## Non-goals
逻辑路径、根行 `shield`/空间名、切换器（5.1b #292）；空目录与不支持态文案、EmptyState、三档布局与长名截断（5.3 #294）；截断提示的格式；mtime 格式（保持 ISO）。

## Capabilities
- MODIFIED `files-web`：Requirement「工作空间页」以已晋升文本为底：
  - 左栏句的"目录树"补条目图标映射与行尾大小（取父 delta 原句）；
  - 右栏预览面板补"预览头显示文件图标、路径、大小、mtime"；
  - 新增 Scenario「树条目图标与大小」（父 delta 同名 Scenario 去掉属 #292/#294 的根行与空目录/不支持子句）。

## Impact
`web/src/features/files/{file-meta.ts(新),tree.tsx,preview.tsx,files.css}`；`web/test/file-meta.test.ts`（新）、`web/test/files-page.test.tsx`（新增用例与 `:102-106` 改写）；`preview.test.tsx` 不改。不加依赖，不动服务端、`web/e2e/**`。

## 与 oracle 偏差留痕
- 父 delta 写"预览头显示文件名、大小、mtime"。demo 预览头（demo:3913-3916）是 `icon + 路径 + 大小 · mtime`，现实现显示工作区相对路径，且 `preview.test.tsx:153-156` 钉住路径。本刀保留路径（路径以文件名结尾），加图标；子 delta 写"文件图标、路径、大小、mtime"。archive 时同步父 delta。
- demo `fmtSize`（demo:932）KB 取整、无 GB；父 delta 要求一位小数与 GB，以父 delta 为准。
- 文件行大小 `aria-hidden`：可访问名保持文件名，大小只作视觉信息。屏幕阅读器可在预览头读到大小。

## Risk triage
- 大小进入按钮可访问名会破坏全部 `getByRole("button", { name: "<文件名>" })` 与 ui-walk 的 exact 定位。F2 钉住。
- `formatSize` 边界（1023/1024、MB/GB 进位、`toFixed` 进位到 `1024.0`）。F1 表驱动钉住。
- 既有 `42 B`/`91 B` 预览断言保持绿，由 `formatSize` 的 `< 1024` 分支保证。
- 行尾大小进入按钮 `textContent`：`files-page.test.tsx:102-106` 需改写为取 `.files-tree-name`，design 已列。
