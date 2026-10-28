## MODIFIED Requirements

### Requirement: 中心页外壳
`/center` SHALL 由 `web/src/features/center/` 渲染：页内 tab 由查询参数 `?tab=<key>` 表示，tab 表 `CENTER_TABS: readonly {key, label, adminOnly, requiresKb?}[]` 在 `tabs.ts`，依次为 `{key:"experts", label:"专家", adminOnly:false}`、`{key:"skills", label:"技能", adminOnly:false}`、`{key:"connectors", label:"连接器", adminOnly:false}`、`{key:"knowledge-bases", label:"知识库", adminOnly:false, requiresKb:true}`、`{key:"models", label:"模型", adminOnly:true}`、`{key:"mount-sources", label:"挂载源", adminOnly:true}`（`专家`、`技能` 与 `连接器` 三项见 experts「中心「专家」tab」、skill-switches「中心「技能」tab」与 connectors「中心「连接器」tab」，`挂载源` 见 workspace-mounts「中心「挂载源」tab」，`知识库` 见 knowledge-bases「中心「知识库」tab」）；可见 tab 为 `adminOnly` 为假或当前 principal 角色为 `管理员` 的项，且带 `requiresKb:true` 的项另须 `GET /api/kb/status` 应答为 `enabled:true`（中心页每次挂载读取一次；读取失败或在途时视为不可见，不阻塞其它 tab 的渲染，读到之后再按规则重算——当前 `?tab=knowledge-bases` 在读到之前不触发 replace 导航）。`tab` 缺省、未知或指向不可见 tab 时 SHALL 以 replace 导航到第一个可见 tab；没有可见 tab 时 SHALL 渲染空态文案 `中心暂无可用内容` 且不渲染 tab 条（按上面的 tab 表不会发生：`专家`、`技能` 与 `连接器` 对所有人可见；规则保留）。tab 条用拷入层 tabs 组件（`role="tablist"`，当前项 `aria-selected="true"`，切换只改 `?tab=`）。页面级 heading 仍归顶栏（spa-shell）。routeManifest 的 `/center` 描述 SHALL 与可见内容一致：按 tab 表次序连接对所有人可见（`adminOnly` 为假）的 tab 的 label——相邻两项之间用顿号 `、`，只有最后两项之间改用 `与`（只有一项时即该 label），仅管理员可见的 tab 与带 `requiresKb:true` 的 tab 不进描述（`模型` 与 `挂载源` 两个 tab 只对管理员可见，`知识库` 只在知识库开启时可见，描述不对所有部署宣传它们）——tab 表只有 `专家` 与 `模型` 时为 `专家`，只有 `专家`、`技能` 与 `模型` 时为 `专家与技能`，上面的完整 tab 表下为 `专家、技能与连接器`；不宣传未交付能力。

#### Scenario: 管理员与普通用户
- **WHEN** 管理员打开 `/center`；再打开 `/center?tab=nope`；再打开 `/center?tab=models`；普通用户打开 `/center?tab=models`；普通用户打开 `/center`
- **THEN** 管理员前两次 URL 都以 replace 变为 `/center?tab=experts`，tab 条依次恰为 `专家`、`技能`、`连接器`、`模型`、`挂载源` 五项（假客户端的知识库状态为 `{enabled:false}`）且 `专家` 选中；第三次 URL 保持 `/center?tab=models`、`模型` 选中；普通用户两次 URL 都以 replace 变为 `/center?tab=experts`，tab 条恰为 `专家`、`技能`、`连接器` 三项（没有 `模型` 与 `挂载源`）且 `专家` 选中，页面不出现 `中心暂无可用内容`；routeManifest 的 `/center` 描述为 `专家、技能与连接器`

#### Scenario: 知识库 tab 随开关显隐
- **WHEN** 假客户端的 `GET /api/kb/status` 为 `{enabled:true, …}` 时管理员与普通用户分别打开 `/center`；为 `{enabled:false}` 时普通用户打开 `/center?tab=knowledge-bases`；状态请求挂起时普通用户打开 `/center?tab=knowledge-bases`，随后应答 `{enabled:true, …}`
- **THEN** 管理员 tab 条依次为 `专家`、`技能`、`连接器`、`知识库`、`模型`、`挂载源`，普通用户为 `专家`、`技能`、`连接器`、`知识库`，两者的 routeManifest 描述都仍为 `专家、技能与连接器`；`enabled:false` 时 URL 以 replace 变为 `/center?tab=experts` 且没有 `知识库`；挂起期间 URL 不变、不渲染 `中心暂无可用内容`，应答后 `知识库` 选中

### Requirement: 模型 tab
`/center?tab=models` SHALL 渲染模型表（拷入层 table）：每行 `id`、`name`、标签 `推理` / `看图`（按布尔）、`maxTokens`、上游（`已配置` / `未配置`）、探活（`从未` / `正常` / `失败：<message>` 与 `at` 的本地时间）、`缺省` 标记，以及行操作 `编辑`、`删除`、`设为缺省`（缺省行不渲染）、`探活`；表上方 `新增模型` 按钮。新增 / 编辑为对话框表单：`id`（编辑时只读）、`name`、`reasoning` / `vision` 复选、`maxTokens` 数字、`efforts` 六个复选（仅 `reasoning` 勾选时启用；视图 `efforts` 为 null 的推理模型预填为一个都不勾，旁注 `不勾选即不声明强度集合，界面列全部档位`；一个都不勾则提交不带 `efforts`）、`上游地址`、`密钥`（编辑时 placeholder `留空保留现有密钥`，空即省略 `apiKey`）；提交前 SHALL 在客户端按与服务端相同的规则逐字段校验并在字段旁显示具体原因（`id` 字节数与控制字符、`name` 码点数与控制字符、`maxTokens` 范围、地址格式、带地址且无已存密钥时必填密钥、填了密钥必填地址），服务端 400 的统一文案只作兜底；提交恰调用一次 `createModel` / `updateModel`，在途禁用提交，失败在对话框内 `role="alert"` 显示 `ApiError.message`。两个对话框 SHALL 接入 ui-primitives 规定的 Escape 关闭回退（`useEscapeFallback`），与既有覆盖层同一行为。保存成功且上游有改动（新建带上游；编辑改了地址或填了密钥）时 SHALL 紧接着恰调用一次 `probeModel`。`删除` 先弹确认（拷入层 alert-dialog，按钮 `取消` / `删除`）；`设为缺省` 与 `探活` 直接调用，在途禁用该行对应按钮。每次操作成功后 SHALL 重取 `listModels` 渲染；收到非信封的 500（发布失败）时同样重取（行已写入）并在页顶 `role="alert"` 显示 `REQUEST_FAILED_MESSAGE`。模型表下方 SHALL 在 `GET /api/kb/status` 为 `enabled:true` 时渲染「知识库模型」段（knowledge-bases 与 ragflow-backend 的设置端点）：嵌入模型的名称、上游地址（`已配置` / `未配置` 密钥）与探活状态，`编辑` 打开对话框（`名称`、`上游地址`、`密钥`——首次必填、之后 placeholder `留空保留现有密钥`），保存后若上游有改动恰调用一次 `probeKbEmbedding`；`知识库对话模型` 下拉（对话模型表的全部 `id` 加 `不使用`），改动即恰一次 `updateKbSettings({chatModelId})`；知识库数、文档数与重建状态（`重建中 N 个` / `重建失败 N 个`），有失败时显示 `重试失败的重建`（恰一次 `retryKbRebuild`）。更换嵌入模型名称或上游地址且知识库数大于 0 时，保存 SHALL 先弹确认（拷入层 alert-dialog，正文 `更换嵌入模型会重建全部 <知识库数> 个知识库（共 <文档数> 份文档），重建期间不能入库。`，按钮 `取消` / `重建并保存`），确认后带 `confirmRebuild:true` 恰调用一次 `updateKbSettings`；取消则不发请求。设置读取失败时该段显示 `知识库服务暂不可用` 与 `重试`。API 客户端 `web/src/lib/api-models.ts` SHALL 提供 `listModels` / `createModel(input)` / `updateModel(id, input)` / `deleteModel(id)` / `setDefaultModel(id)` / `probeModel(id)`，查询参数 `id` 经 `encodeURIComponent`，响应按 `ModelView` 严格解析（键集与类型不符即 `requestFailed`），`api.ts` 导出其类型。

#### Scenario: 登记、编辑与探活
- **WHEN** 管理员点 `新增模型`，填 `id` `m2`、勾 `推理`、勾 `low` `high`、填地址与密钥，提交（假客户端返回视图）；随后编辑 `m2` 只改 `name`；再编辑改地址不填密钥
- **THEN** 第一次 `createModel` 的 input 恰为 `{id:"m2", reasoning:true, efforts:["low","high"], upstream:{baseUrl, apiKey}}`（未碰的键不发），随后恰一次 `probeModel("m2")`；第二次 `updateModel` 的 input 含 `upstream:{baseUrl}`（不含 `apiKey`）且没有探活；第三次有探活；每次成功后恰一次 `listModels`

#### Scenario: 删除与缺省
- **WHEN** 管理员对非缺省行点 `删除` 并确认；对另一行点 `设为缺省`；`deleteModel` 返回 409 信封
- **THEN** 确认后恰一次 `deleteModel`；`设为缺省` 恰一次 `setDefaultModel`，刷新后该行有 `缺省` 标记且不再有 `设为缺省` 按钮；409 时行内显示信封文案、行仍在

#### Scenario: 更换嵌入模型需确认
- **WHEN** 知识库设置为 `{embedding:{name:"bge-m3", …}, bases:2, documents:5, …}` 时管理员把名称改为 `text-embedding-3-small` 并保存，在确认框点 `取消`；再保存并点 `重建并保存`
- **THEN** 确认框正文含 `2 个知识库（共 5 份文档）`；取消后没有 `updateKbSettings` 请求；确认后恰一次 `updateKbSettings`，其 input 含 `confirmRebuild:true`，随后恰一次 `probeKbEmbedding`
