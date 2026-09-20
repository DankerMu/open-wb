## ADDED Requirements
### Requirement: 文件预览纯组件
`mdRender(src)`、`CsvTable`、`CodeView`、`PreviewPane` SHALL 提供无网络依赖的安全预览。Markdown SHALL 支持 demo 的标题、列表、代码块、表格、行内代码、粗体和不可跳转链接，源 HTML 作为文本转义；代码内容 SHALL 保持字面值。CSV SHALL 以首行为表头并显示 `共 N 行 · 大文件仅预览前若干行`；其余文本 SHALL 显示带行号代码表，JSON 尝试格式化、失败保留原文。预览 SHALL 显示路径、大小、mtime；Markdown 默认渲染且可切换 `查看源码`/`渲染视图`，切换文件重置模式。图片 SHALL 用提供的 URL 渲染 img；组件不负责 URL 分配/释放。不支持类型 SHALL 显示 `该类型不支持预览`，提供的错误 message SHALL 内联显示；截断状态 SHALL 显示提示和原始总大小。移植文件 SHALL 保留来源说明，demo 原始文件头不得改动。
用户授权的病态深度规范化 SHALL 将规范节点每条祖先链的 `strong` 限制为最多 64 层；可省略超出的冗余粗体包装，但 SHALL 保留全部文字顺序、所有不可跳转链接及其作用范围和可见格式。普通/浅层 demo 行为不变，代码保持字面值；HTML 与 React SHALL 使用同一规范化结构，不使用文本截断、纯文本降级或危险 HTML 注入。
#### Scenario: 安全 Markdown
- WHEN 输入标题/列表/代码/链接及 script、javascript 目标、onerror 属性注入载荷
- THEN 语义 DOM 与支持的 demo 子集一致；源载荷不生成执行元素或事件属性；HTML 与 React 预览链接均为 href="#" 且鼠标/键盘操作不跳转，代码中标记保持字面值
#### Scenario: 表格与代码
- WHEN CSV 为一行表头及两行数据，或代码含两行和末尾空行
- THEN CSV 表头可见且注记共2行；代码表有三行并显示1..3行号，内容安全且保留空白
#### Scenario: 预览状态
- WHEN 切换 Markdown 渲染/源码后换文件，或展示图片、不支持类型、错误、截断文本
- THEN 新 Markdown 默认渲染；各状态显示对应内容、错误消息与原始大小，图片使用传入URL且不发起API调用
#### Scenario: 深层结构生命周期
- WHEN 同一实例从浅层预览切换到接近 1 MiB 的深层重建格式，再切换到普通文档、操作源码按钮并卸载
- THEN `strong` 祖先最多 64 层，全部文字及链接保留，开发/生产及 StrictMode 生命周期完成且无新增控制台/页面错误
