## MODIFIED Requirements

### Requirement: 目录树与预览
目录树 SHALL 进入空间请求根一层并默认展开根；目录首次展开请求该层，折叠重开复用成功缓存，保持服务端排序与 workspace-relative 路径。位置下拉 SHALL 仅包含根和成功加载过的目录，已折叠缓存可复用，不额外递归请求。点击文件 SHALL 交给 `PreviewPane`（「文件预览纯组件」与 file-previewers），不得另写渲染器。浏览器 SHALL NOT 以扩展名白名单预先判定「不支持」：除 file-previewers「类别判定与预览器选择」里按扩展名确定走其它数据来源的类别（PDF、办公文档、音视频、压缩包）与网页的渲染视图（`html`、`htm` 默认由隔离预览来源加载，切到源码视图时才发 `file` 请求，见 file-previewers「隔离来源的嵌入与令牌」）之外，选中文件恰发出一次 `file` 请求，是否可预览由响应决定。`刷新` 按钮 SHALL 对全部已加载过的目录重新请求 `tree` 并重新取当前文件的预览，保留展开状态、选中文件与 Markdown 等视图模式；刷新失败时保留旧列表并就地显示失败文案。「重新取」对每一类预览都成立，再点已选中的文件行与之相同（owner 2026-10-11 裁决）：经 `file` 取正文的类别重新请求一次 `file`；压缩包重新请求一次 `archive`；音视频换一个新的媒体元素，其地址追加 `&v=<n>` 使浏览器重新请求（file-previewers「音视频」，owner 2026-10-12 裁决，#1356）；网页的渲染视图换一个新的 iframe，预览令牌按 file-previewers「隔离来源的嵌入与令牌」必要时先重新签发。经 `file` 或 `archive` 重取期间 SHALL 保留上一次的结果（正文、列表或失败文案）并在其后显示 `正在读取文件`（`role="status"`），新结果到达后才替换。
页面 SHALL 以 workspace identity 隔离树/当前文件/预览局部模式；同 workspace 同文件文本刷新保留视图模式。取消、切换和卸载 SHALL 阻止旧响应提交状态；图片 URL SHALL 在替换、卸载及迟到结果丢弃时释放，abort 本身不替代释放。
目录列表缓存与目录错误的按路径取值 SHALL 只认该路径自己登记过的值（#1340）：目录名与 JavaScript 对象原型成员同名（`constructor`、`__proto__`、`toString`、`hasOwnProperty`、`valueOf` 等）时与其它目录名完全同样处理——没有展开过即未加载：不出现在位置下拉里，展开时照常请求该层并显示其内容；没有失败过即没有错误行，失败时显示的是那一次失败的文案。这类目录 SHALL NOT 使页面在渲染期抛出。

#### Scenario: 刷新总是重取
- **WHEN** `clip.mp4` 已触发 `error`、点 `刷新`；`归档.zip` 已显示列表、下一次 `archive` 应答挂起时点 `刷新`
- **THEN** `clip.mp4` 处 `无法播放该文件` 消失、出现一个新的 `video` 元素、`src` 由 `…/file?path=clip.mp4` 变为 `…/file?path=clip.mp4&v=<n>`（n 为正整数；再点一次 n 更大；改选 `readme.md` 再选回 `clip.mp4` 不带 `v`，此后再 `刷新` 的 n 仍大于此前各次）、页面没有经 `fetch` 发出 `file` 请求；`归档.zip` 的 `archive` 请求由一次变两次，挂起期间旧列表仍在且其后有 `正在读取文件`，应答到达后换成新列表、状态行消失

#### Scenario: 一次浏览
- WHEN 根包含 out/、readme.md、notes.csv、logo.png、归档.zip、blob.bin，展开 out 并依次点击五个文件，随后新建目录
- THEN out 首次展开恰一次 tree 请求，重开不重取；Markdown h1/源码行号切换、CSV 表头/共2行、图片可见；zip 显示压缩包列表（一次 `archive` 请求、零 `file` 请求）；`blob.bin` 恰一次 `file` 请求、收到 415 后显示 `该类型不支持预览`；新目录成功后所属层更新
- WHEN 同一棵树里另有 `site/index.html`，选中它，再点 `查看源码`
- THEN 选中时零 `file` 请求（渲染视图来自隔离预览来源）；点 `查看源码` 后恰一次 `file` 请求

#### Scenario: 工作空间和请求归属
- WHEN 两空间均有 readme.md，旧树/预览/创建响应在切换后完成，或同文件刷新
- THEN 新空间不被旧响应污染且 Markdown 默认渲染；同文件刷新保留模式；新建目录下拉不触发未展开目录探测

#### Scenario: 图片资源完整生命周期
- WHEN 图片被替换、页面卸载、或已取消请求迟到分配图片 URL，包含 StrictMode 生命周期
- THEN 每个分配的 URL 在失去 owner 时释放，旧结果不显示；新请求/新会话保持可用

#### Scenario: 内联错误
- WHEN 当前 tree/preview/mutation 返回非 401 错误或网络失败
- THEN 对应表面结束 loading 并显示信封 message 或稳定回退；当前 401 交由认证守卫，不显示旧页面错误

#### Scenario: 手动刷新
- WHEN 根与 `out` 已展开、当前以源码模式预览 `readme.md`，磁盘上新增了 `out/new.md`，点 `刷新`
- THEN 恰对根与 `out` 各发一次 `tree`、对 `readme.md` 发一次 `file`；`out/new.md` 出现；`out` 仍展开，`readme.md` 仍被选中且仍是源码模式

#### Scenario: 与对象原型成员同名的目录
- **WHEN** 根列表含目录 `constructor`、`__proto__`、`toString` 与 `hasOwnProperty`；页面渲染后打开 `新建文件夹` 查看位置下拉；随后展开 `constructor`（其下有 `a.md`）；再展开 `__proto__`，这一次 `tree` 以 500 信封失败
- **THEN** 页面正常渲染，没有未捕获的异常，四个目录各有一行；展开之前位置下拉只有根，四个目录都没有错误行；展开 `constructor` 恰发出一次对该层的 `tree` 请求并列出 `a.md`，此后位置下拉多出 `constructor`；`__proto__` 一行之下显示该信封的 message，`toString` 与 `hasOwnProperty` 仍没有错误行、也没有被当成已加载

### Requirement: 工作空间浏览器组件
`web/src/features/files/` SHALL 经其 `index.ts` 导出 `WorkspaceBrowser`：给定 API 客户端、工作空间 id、账号与可选的空间名 / `dir`，它渲染目录树、预览区与全部文件操作，并以受控属性接收与上报「当前路径」（`path` / `onPathChange`）；它另接受可选的 `markedPaths`（带标记的路径集合及其可访问文本）、`onlyPaths`（只显示由这些路径构成的子树，此时不请求 `tree`；其中已被判定为不存在的路径不列出，列出的每个文件行都可选中，不论它的父目录是否加载过；选中后 `file` / `archive` 应答 404 的行被移出、选中被清除并以 `onPathChange(null)` 上报——判定、移出与作废的规则见 workspace-sidebar「本会话改动标记与过滤」，这些只在给了 `onlyPaths` 时发生）、`layout`（`columns`：树左预览右；`stacked`：树上预览下、树可收起）与一个命令式的 `reveal(path, {view?})`（逐级展开并选中，可指定网页文件的视图）与 `refresh(paths?)`（重新请求已加载目录中与这些路径相关的层；省略参数时全部已加载的层）。文件页以 `columns` 布局包一层并把当前路径接到地址的 `path`；会话页侧边栏以 `stacked` 布局包一层（workspace-sidebar）。`WorkspaceBrowser` SHALL 另向宿主上报树里实际选中的文件（没有选中文件时上报空值），实际选中每变化一次上报一次：由 `path` 发起的定位没有落在文件上（文件不存在、某一级父目录请求失败、`path` 指向目录）时，宿主得到的是定位之后的实际选中，而不是被定位的路径；宿主以同一个路径再次发起定位（会话页卡片的再次点击）时 SHALL 重新走一遍定位，不因 `path` 的值没变而不动（#1380）。文件页 SHALL NOT 据这项上报改写地址（「地址定位到文件」：定位不改写地址，只有用户选中才写）。目录树、预览与文件操作 SHALL 只有这一份实现；`WorkspaceBrowser` SHALL NOT 读写地址、SHALL NOT 依赖会话页的任何模块（`web/src/features/files` 不从 `web/src/features/chat` 导入）。

#### Scenario: 两处同一份实现
- **WHEN** 静态扫描 `web/src/features`
- **THEN** `web/src/features/files` 下没有文件导入 `web/src/features/chat`；`web/src/features/chat` 只经 `features/files/index` 导入文件页的东西；目录树的行组件与预览面板在仓库里各只有一个定义

#### Scenario: 受控路径与定位
- **WHEN** 以 `path="out/a.md"` 渲染 `WorkspaceBrowser`；随后调用 `reveal("src/deep/app.ts")`；再调用 `refresh(["out/b.md"])`
- **THEN** 初始时展开到 `out` 并选中 `a.md`；`reveal` 之后依次请求未加载的 `src`、`src/deep`，以 `src/deep/app.ts` 调用 `onPathChange`；`refresh` 只对根与 `out` 中已加载的层重新请求；组件自身没有读写 `location`

#### Scenario: 标记与子树
- **WHEN** 以 `markedPaths={"out/a.md"}`、标记文本 `本会话已改动` 渲染并展开 `out`；随后传入 `onlyPaths={"out/a.md","x/y.md"}`
- **THEN** `out` 与 `out/a.md` 两行带该文本的标记；传入 `onlyPaths` 之后树恰为 `out → a.md` 与 `x → y.md`，没有新的 `tree` 请求

#### Scenario: 实际选中的上报与重复定位
- **WHEN** 已选中 `readme.md` 时以 `path="out/gone.md"` 发起定位，而 `out` 的列表里没有它；随后 `out/gone.md` 被建出并经 `refresh(["out/gone.md"])` 进入 `out` 的列表，宿主对同一路径再次发起定位
- **THEN** 第一次定位结束后宿主收到的实际选中为空，预览区显示 `文件不存在`；第二次定位没有因为路径相同而被忽略：`out/gone.md` 被选中并显示预览，宿主收到的实际选中为 `out/gone.md`；两次都没有读写 `location`
