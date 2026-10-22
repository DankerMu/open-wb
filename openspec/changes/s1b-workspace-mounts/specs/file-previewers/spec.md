# file-previewers Spec Delta

> s1b-workspace-mounts：以主规格为底（兄弟 change 都不改本能力）。「隔离来源的嵌入与令牌」「PDF 与办公文档」：宿主标明文件在已登记挂载内时，隔离来源的预览器不签发、不建 iframe，显示固定文案，`查看源码` 照常；这一判定先于 PDF 与办公文档既有的三项，被挡下的预览不触发续期。只做插入，场景标题全部保留，加一个场景（design D18、D21）。其余逐字沿用主规格。

## MODIFIED Requirements

### Requirement: 隔离来源的嵌入与令牌
需要隔离预览来源的预览器（网页的渲染视图、PDF、办公文档）SHALL 经 `issuePreviewToken(workspaceId)` 取得 `{base, officeBase, expiresAt, documentMaxBytes, officeAvailable}`，并把文件路径按段 `encodeURIComponent` 后接在 `base`（或 `officeBase`）之后作为 iframe 的 `src`；页面 SHALL NOT 自己拼接预览来源的主机或端口。同一工作空间在一个页面里 SHALL 共用一次签发的结果；只要有这样的预览处于挂载状态，页面 SHALL 每 5 分钟再调用一次 `issuePreviewToken` 续期（返回同一个 `base` 时 iframe 不重载；返回了不同的 `base` 时以新地址重载），没有这样的预览时不续期；此后再次出现这样的预览时，距上一次签发不足 5 分钟 SHALL 复用上一次的结果、不重新签发，否则重新签发（owner 2026-10-11 认可）。网页的渲染视图、PDF 与办公文档下 `刷新` 或再点已选中的同一行时，距上一次成功签发不足 5 分钟的不发签发请求、续期时刻不变（适用面含 PDF 与办公文档、门槛取 5 分钟：owner 2026-10-12 认可）；其余情况——签发失败态、还没有成功签发过（在途的那一次被中止）、或距上一次成功签发已满 5 分钟——SHALL 立即重新签发一次，新结果到达之前不建 iframe。需要令牌的预览重新出现时距上一次成功签发已满 5 分钟的，SHALL 先重新签发：自重新出现的那一次渲染起到新结果到达为止显示 `正在加载预览…`，不以旧 `base` 建 iframe。签发失败（非 401）时预览区显示信封 message 或安全文案，网页仍可切到源码视图。令牌与 `base` SHALL NOT 被写入地址栏、`localStorage`、日志或任何持久存储，SHALL NOT 出现在界面可见文本里。宿主标明所选文件位于该空间的已登记挂载内时（files-web「工作空间页」，change s1b-workspace-mounts），网页的渲染视图、PDF 与办公文档 SHALL 不签发预览令牌、不建 `iframe`，预览区显示 `挂载目录内的文件暂不支持预览，请下载查看`，预览头的下载链接照常；网页的 `查看源码` 照常可用（经 `fetchPreview`）。这样被挡下的预览不是「处于挂载状态」的需要隔离来源的预览：它不引起签发、不引起也不维持 5 分钟续期，`刷新` 或再点同一行也不签发（预览来源对挂载内路径一律 404，workspace-mounts「宿主不同步进入挂载」）。

网页渲染视图的 iframe SHALL 带 `sandbox="allow-scripts allow-forms allow-modals"`（恰这三个令牌，没有 `allow-same-origin`）、`referrerpolicy="no-referrer"` 与 `title="<文件名>"`，SHALL NOT 使用 `srcdoc`。网页默认显示渲染视图，可在 `查看源码` 与 `渲染视图` 之间切换，切换文件时重置为渲染；源码视图经 `fetchPreview` 取文本（1 MiB 截断与截断提示照常），渲染视图不受该上限约束。

#### Scenario: 网页渲染视图
- **WHEN** 选中 `site/index.html`，`issuePreviewToken` 返回 `base` 为 `http://127.0.0.1:4100/w/<T>/`
- **THEN** 预览区有一个 `iframe`，`src` 恰为 `http://127.0.0.1:4100/w/<T>/site/index.html`，`sandbox` 属性恰为 `allow-scripts allow-forms allow-modals`，`referrerpolicy` 为 `no-referrer`，`title` 为 `index.html`，没有 `srcdoc`；此时没有发出 `file` 请求；点 `查看源码` 后发出一次 `file` 请求并显示带行号的源码，按钮变为 `渲染视图`

#### Scenario: 路径编码
- **WHEN** 选中 `报告 2026/a b#1.html`
- **THEN** iframe 的 `src` 为 `<base>` 后接 `%E6%8A%A5%E5%91%8A%202026/a%20b%231.html`（各段分别编码，`/` 保留）

#### Scenario: 签发失败后刷新
- **WHEN** 第一次签发返回 500、第二次成功，选中 `index.html` 后点 `刷新`
- **THEN** 先是失败文案、没有 iframe；`刷新` 后签发请求恰两次，iframe 出现且 `src` 为新 `base` 加路径，全程零 `file` 请求

#### Scenario: 过期的 base 不建首帧
- **WHEN** 选中 `index.html`（`base` 为 A），改选 `readme.md`，6 分钟后再选 `index.html`（签发返回 B）
- **THEN** 第二次签发落定之前文档里没有建过 iframe；落定后 `src` 以 B 开头；签发请求合计两次

#### Scenario: 共用与续期
- **WHEN** 在同一工作空间里先后预览两个 html 与一个 pdf，停留 11 分钟（使用假定时器），随后切到一个 `md` 文件再停留 6 分钟
- **THEN** 前三次预览合计恰一次签发请求；停留期间恰两次续期请求，iframe 的 `src` 未变、没有重载；切到 `md` 之后没有新的签发请求

#### Scenario: 签发失败
- **WHEN** `issuePreviewToken` 返回 404（预览未装配）或网络失败时选中 `index.html`
- **THEN** 渲染视图处显示失败文案，没有 `iframe`；`查看源码` 可用并能显示源码；预览头的下载链接仍在

#### Scenario: 挂载内文件不签发
- **WHEN** 宿主标明文件在挂载 `远端` 内，依次选中 `远端/site/index.html`、`远端/doc.pdf`、`远端/plan.docx`（`officeAvailable` 为 `false`）与 150 MB 的 `远端/huge.pdf`（`documentMaxBytes` 为 104857600），停留 6 分钟（使用假定时器）；再在 `远端/site/index.html` 上点 `查看源码`；随后选中不在挂载内的 `site/index.html`
- **THEN** 四者的预览区都显示 `挂载目录内的文件暂不支持预览，请下载查看`（不显示 `服务器未启用文档转换，请下载后查看` 或 `文件过大，无法预览`），都没有 `iframe`，预览头都有下载链接；停留期间零 `issuePreviewToken` 请求；`查看源码` 后恰一次 `file` 请求并显示带行号的源码；选中 `site/index.html` 后恰一次签发并建 `iframe`

### Requirement: PDF 与办公文档
PDF SHALL 以不带 `sandbox` 属性的 `iframe`（`title` 为文件名）从 `base` 加载，交给浏览器自带的查看器。办公文档（`docx`、`xlsx`、`pptx`）SHALL 以同样的 `iframe` 从 `officeBase` 加载（服务端转成 PDF）；在 iframe 的 `load` 事件之前预览区 SHALL 盖一层 `正在转换文档…`（`role="status"`），`load` 之后撤掉——转换失败时 iframe 里是服务端的失败说明页。宿主标明文件在已登记挂载内时（「隔离来源的嵌入与令牌」），SHALL 先于下列三项判定显示 `挂载目录内的文件暂不支持预览，请下载查看`，不签发、不建 iframe（change s1b-workspace-mounts）。建 iframe 之前 SHALL 依次判定：树条目的大小超过 `documentMaxBytes` → 显示 `文件过大，无法预览`，不建 iframe（树条目没有大小时跳过这一项，框内显示预览来源自己的应答，#1372）；办公文档且 `officeAvailable` 为 `false` → 显示 `服务器未启用文档转换，请下载后查看`，不建 iframe；`navigator.pdfViewerEnabled === false` → 显示 `此浏览器不支持内嵌 PDF 预览，请下载后查看`，不建 iframe。三种情况都保留预览头的下载链接。

#### Scenario: PDF 的嵌入
- **WHEN** 选中 2 MB 的 `doc.pdf`
- **THEN** 预览区有一个 `iframe`，`src` 为 `<base>doc.pdf`，没有 `sandbox` 属性，`title` 为 `doc.pdf`

#### Scenario: 办公文档的嵌入与转换提示
- **WHEN** 选中 `plan.docx`，`officeAvailable` 为 `true`；随后 iframe 触发 `load`
- **THEN** iframe 的 `src` 为 `<officeBase>plan.docx`、没有 `sandbox` 属性；`load` 之前可见 `正在转换文档…`，之后不可见

#### Scenario: 不建 iframe 的三种情况
- **WHEN** 选中 150 MB 的 `huge.pdf`（`documentMaxBytes` 为 104857600）；`officeAvailable` 为 `false` 时选中 `a.xlsx`；`navigator.pdfViewerEnabled` 为 `false` 时选中 `doc.pdf`
- **THEN** 依次显示 `文件过大，无法预览`、`服务器未启用文档转换，请下载后查看`、`此浏览器不支持内嵌 PDF 预览，请下载后查看`；三者都没有 `iframe`，都有下载链接

#### Scenario: 大小未知的文档
- **WHEN** 选中一个没有大小的 `deep/doc.pdf` 行（`navigator.pdfViewerEnabled` 不为 `false`）
- **THEN** 预览区有一个 `iframe`，`src` 为 `<base>deep/doc.pdf`；没有显示 `文件过大，无法预览`；预览头有下载链接
