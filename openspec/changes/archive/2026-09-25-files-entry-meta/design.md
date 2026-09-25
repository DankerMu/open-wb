# Design: files-entry-meta（#293）

Fixture level: expanded（父 tasks 组 5 声明）。
Risk packs: Public API / CLI / script entry（文件行可访问名是 jsdom 与 ui-walk 定位面）；Legacy compatibility（既有预览大小断言不变；文件树用例只改写 `files-page.test.tsx:102-106`）。

Change surface:
- 新增：`web/src/features/files/file-meta.ts`、`web/test/file-meta.test.ts`。
- 修改：`web/src/features/files/tree.tsx`、`web/src/features/files/preview.tsx`、`web/src/features/files/files.css`；结构断言加在 `web/test/files-page.test.tsx`（若超 size-guard 则新建 `web/test/files-entry-meta.test.tsx`）。
- 不改：`web/e2e/**`、`web/src/ui/**`、`web/src/lib/**`、服务端、`page.tsx`、`dialogs.tsx`、`md-render.ts`、`csv.ts`。

Must preserve:
- 文件行按钮可访问名恰为 `entry.name`（大小 span `aria-hidden`；注意 `textContent` 仍包含它）；目录行按钮 `aria-label` 仍为 `展开|折叠 <label>`；`aria-current`、`aria-expanded`、选中类名不变。
- 预览头路径文本（`preview.test.tsx:153-156`）、`42 B · <ISO>`/`91 B · <ISO>` 文本、截断提示 `预览已截断（原始大小 N B）`（字节原值）不变。
- 前端可预览扩展名集合与 unsupported 行为不变。
- 既有测试的唯一改写：`files-page.test.tsx:102-106` 以按钮 `textContent` 列举树行名，文件行追加大小后会变成 `readme.md8 B`。改为 `button.querySelector(".files-tree-name")?.textContent`，保留行序与名称意图（目录按钮带 `展开 X` aria-label，故原用例取 textContent）。其余树用例按 exact 名定位，不受影响。
- ui-walk 全绿、不改。
- ui-guardrails：feature css/tsx 无字面颜色或 palette，基元只经 `ui/index.js`；注释不含 `#NNN`。size-guard：各文件 ≤ 800 行。

Must add/change:
- `file-meta.ts`：
  ```ts
  import type { IconName } from "../../ui/index.js";
  const ICON_BY_EXTENSION = new Map<string, IconName>([   // Map：只查自有条目，`x.constructor` 等不会命中 Object.prototype
    ["png", "image"], ["jpg", "image"], ["jpeg", "image"],
    ["zip", "archive"], ["tar", "archive"], ["gz", "archive"],
    ["csv", "table"],
    ["md", "file-text"], ["txt", "file-text"], ["log", "file-text"],
    ["json", "file-code"], ["js", "file-code"], ["ts", "file-code"], ["tsx", "file-code"], ["html", "file-code"],
  ]);
  export function fileIcon(name: string): IconName {
    const dot = name.lastIndexOf(".");
    if (dot < 0) return "file";   // 与 supportsPreview（tree.tsx:81-87）、fileExtension（preview.tsx:38-41）同一规则
    return ICON_BY_EXTENSION.get(name.slice(dot + 1).toLowerCase()) ?? "file";
  }
  const UNITS = ["KB", "MB", "GB"] as const;
  export function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    let value = bytes / 1024;
    let unit = 0;
    while (unit < UNITS.length - 1 && Number(value.toFixed(1)) >= 1024) { value /= 1024; unit += 1; }
    return `${value.toFixed(1)} ${UNITS[unit]}`;
  }
  ```
  - `IconName` 已由 `web/src/ui/index.ts:9` 导出，不改 `ui/`。
  - 扩展名取最后一个 `.` 之后，与既有可预览判断同一规则：`.md` → `file-text`（与它按 Markdown 预览一致），`.env` → `file`，`a.` → 空扩展名 → `file`，`archive.tar.gz` → `archive`。
- `tree.tsx`：
  - `Icon` 不接受 `className`（`web/src/ui/icon.tsx:67-80`，props 只有 `name/size/label`），且 `ui/**` 不改：图标一律包一层 `span` 承接既有类，`size={14}`（demo:697 与现 glyph 均为 14px）。
  - 目录行：第二个 svg（文件夹形）替换为 `<span className="files-tree-glyph"><Icon name="folder" size={14} /></span>`；caret svg 保留。
  - 文件行：svg 替换为 `<span className="files-tree-glyph"><Icon name={fileIcon(entry.name)} size={14} /></span>`；`files-tree-name` 之后追加 `<span aria-hidden="true" className="files-tree-size">{formatSize(entry.size)}</span>`。
- `preview.tsx`：删 `formatByteSize`；`files-preview-toolbar` 内在路径 `<p>` 前加 `<span className="files-preview-icon"><Icon name={fileIcon(name)} size={16} /></span>`；meta 文本 `${formatSize(size)} · ${new Date(mtime).toISOString()}`。
- `files.css`：
  - `.files-tree-glyph` 既有规则（`files.css:134-143`：14px、`--wb-text-secondary`、选中行 `--wb-brand-primary-deep`）保留，补 `display:inline-flex`，svg 以 `currentColor` 继承颜色。
  - `.files-tree-name` 保持 `overflow-wrap:anywhere`（长名截断与 `title` 属 5.3 #294），只补 `flex:1`；`.files-tree-size { flex:none; margin-left:auto; white-space:nowrap; font-size:10.5px; color:var(--wb-text-tertiary); }`（demo:699 `.fs-node i`）。文件行按钮保证 `display:flex; align-items:center`。
  - `.files-preview-icon { display:inline-flex; flex:none; color:var(--wb-text-secondary); }`，与路径同行。
  - 注释：`adapted from resource/workbuddy-live-demo.html:694-706（.fs-node 图标与行尾大小、预览头 crumb）`。

Sketch seams under test：
- (F1) `web/test/file-meta.test.ts` 表驱动：
  - `fileIcon`：`a.png|a.JPG|a.jpeg`→image，`a.zip|a.tar|a.tar.gz|a.GZ`→archive，`a.csv`→table，`a.md|a.TXT|a.log`→file-text，`a.json|a.js|a.ts|a.tsx|a.html`→file-code，`a.pdf|Makefile|.env|a.|README`→file；`.md`→file-text（与可预览判断同规则）。
  - `formatSize`：`0→"0 B"`、`1→"1 B"`、`1023→"1023 B"`、`1024→"1.0 KB"`、`2048→"2.0 KB"`、`1536→"1.5 KB"`、`1048575→"1.0 MB"`、`1048576→"1.0 MB"`、`90_492_109→"86.3 MB"`、`1073741823→"1.0 GB"`、`1073741824→"1.0 GB"`、`5 * 1024 ** 4→"5120.0 GB"`（GB 封顶）。
- (F2) 树条目：`files-page.test.tsx` 新增一个 `it`，自建根层路由（`out/` 目录、`readme.md` 2048、`notes.csv` 1536、`logo.png` 90_492_109、`归档.zip` 12，外加 `readme.md` 的 file 路由），不复用既有浏览用例（其大小为 8/24/8/2 且文件名为 `archive.zip`）：
  - 每个文件行按钮内 svg 带 `lucide-file-text`/`lucide-table`/`lucide-image`/`lucide-archive` 类（lucide 默认类，见 #288 C2 先例）；目录行 `展开|折叠 out` 按钮内带 `lucide-folder`。
  - 行尾 `.files-tree-size` 文本依次为 `2.0 KB`、`1.5 KB`、`86.3 MB`、`12 B`，且 `aria-hidden="true"`。
  - `getByRole("button", { name: "readme.md" })` 等四个 exact 名仍唯一命中（大小不进可访问名）。
- (F3) 预览头：同一用例点击 `readme.md`，`await waitFor` 直到 `.files-preview-toolbar` 出现（它只在 preview 非空后渲染，`tree.tsx:271-283`），再在 toolbar 范围内断言含 `lucide-file-text` svg（树行也有同类图标，必须限定范围）与 meta 文本 `2.0 KB · <ISO>`。
- (F4) 静态契约（`readRepoFile`）：`web/src` 下不含 `formatByteSize`；`tree.tsx` 与 `preview.tsx` 含 `fileIcon(` 与 `formatSize(`；`tree.tsx` 不再含文件形 svg 路径 `M5 2h5l4 4v8H5z` 与文件夹形 `M2 4.5h4l1.5 2H14V13H2z`，含 `size={14}`；`files.css` 含 `demo.html:694-706` 来源注释，`.files-tree-size {` 规则块含 `var(--wb-text-tertiary)` 与 `font-size: 10.5px`，`.files-tree-name {` 规则块仍含 `overflow-wrap: anywhere` 且不含 `text-overflow`，无十六进制色值。
- 既有 `preview.test.tsx` 的 `42 B`/`91 B`/截断断言不改且全绿。

Required evidence：
- F1–F4 在现实现上先红，记录原因；实现后转绿。
- 反向注入各自变红并回退（记录失败的测试名）：
  1. `formatSize` KB 取整（`Math.round`）→ F1 `1536` 行、F2 红。
  2. 去掉进位循环（1048575 → `1024.0 KB`）→ F1 红。
  3. 无 GB（MB 封顶）→ F1 GB 行红。
  4. `fileIcon` 大小写敏感 → F1 大写行红。
  5. `fileIcon` 取第一个 `.` 之后（`a.tar.gz` → `tar.gz` → file）→ F1 红。
  6. 表中删掉 `tsx` → F1 `a.tsx` 行红。
  7. 大小 span 去掉 `aria-hidden` → F2 exact 名断言红。
  8. 目录行不换 `Icon folder` → F2/F4 红。
  9. 预览头不加图标 → F3 红。
  10. 保留 `formatByteSize` → F4 红。
- `make check`、`npm run build --workspace web`、`(cd web && npx vitest run)`、CI 形态 ui-walk 全部 exit 0。

Not yet specified:
- 窄屏下名称换行（`overflow-wrap:anywhere`）、大小不换行；名称截断与 `title` 及三档布局细调归 5.3 #294。
