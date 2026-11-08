## MODIFIED Requirements

### Requirement: 模型 tab
`/center?tab=models` SHALL 渲染模型表（拷入层 table）：每行 `id`、`name`、标签 `推理` / `看图`（按布尔）、`maxTokens`、上游（`已配置` / `未配置`）、探活（`从未` / `正常` / `失败：<message>` 与 `at` 的本地时间）、`缺省` 标记，以及行操作 `编辑`、`删除`、`设为缺省`（缺省行不渲染）、`探活`；表上方 `新增模型` 按钮。新增 / 编辑为对话框表单：`id`（编辑时只读）、`name`、`reasoning` / `vision` 复选、`maxTokens` 数字、`efforts` 六个复选（仅 `reasoning` 勾选时启用；视图 `efforts` 为 null 的推理模型预填为一个都不勾，旁注 `不勾选即不声明强度集合，界面列全部档位`；一个都不勾则提交不带 `efforts`）、`上游地址`、`密钥`（编辑时 placeholder `留空保留现有密钥`，空即省略 `apiKey`）；提交前 SHALL 在客户端按与服务端相同的规则逐字段校验并在字段旁显示具体原因（`id` 字节数与控制字符、`name` 码点数与控制字符、`maxTokens` 范围、地址格式、带地址且无已存密钥时必填密钥、填了密钥必填地址），服务端 400 的统一文案只作兜底；提交恰调用一次 `createModel` / `updateModel`，在途禁用提交，失败在对话框内 `role="alert"` 显示 `ApiError.message`。两个对话框 SHALL 接入 ui-primitives 规定的 Escape 关闭回退（`useEscapeFallback`），与既有覆盖层同一行为。保存成功且上游有改动（新建带上游；编辑改了地址或填了密钥）时 SHALL 紧接着恰调用一次 `probeModel`。`删除` 先弹确认（拷入层 alert-dialog，按钮 `取消` / `删除`）；`设为缺省` 与 `探活` 直接调用，在途禁用该行对应按钮。每次操作成功后 SHALL 重取 `listModels` 渲染；收到非信封的 500（发布失败）时同样重取（行已写入）并在页顶 `role="alert"` 显示 `REQUEST_FAILED_MESSAGE`。模型表下方 SHALL 在 `GET /api/kb/status` 为 `enabled:true` 时渲染「知识库模型」段（knowledge-bases 与 ragflow-backend 的设置端点；不看 `available`，见 ragflow-backend「知识库可用性」）：嵌入模型的名称、上游地址（`已配置` / `未配置` 密钥）与探活状态，`编辑` 打开对话框（`名称`、`上游地址`、`密钥`——首次必填、之后 placeholder `留空保留现有密钥`），保存后若上游有改动恰调用一次 `probeKbModel("embedding")`；重排模型一行：未配置显示 `未配置` 与 `编辑`，配置了显示名称、上游地址（`已配置` / `未配置` 密钥）与探活状态，加 `编辑`、`探活`、`清除`——`编辑` 打开与嵌入模型同一形式的对话框（`名称`、`上游地址`、`密钥`，规则同嵌入模型，没有重建确认），保存后若上游有改动恰调用一次 `probeKbModel("rerank")`；`探活` 恰一次 `probeKbModel("rerank")`；`清除` 先弹确认（拷入层 alert-dialog，标题 `清除重排模型？`，正文 `清除后检索不再重排。`，按钮 `取消` / `清除`），确认后恰一次 `updateKbSettings({rerank:null})`，取消则不发请求；`知识库对话模型` 下拉（对话模型表里带上游的 `id` 加 `不使用`），改动即恰一次 `updateKbSettings({chatModelId})`；已指定且 `compileBases` 大于 0 时下拉禁用，旁注 `已有 <compileBases> 个开启 RAPTOR 或知识图谱的知识库，不能更换或取消`；知识库数、文档数与重建状态（`重建中 N 个` / `重建失败 N 个`），有失败时显示 `重试失败的重建`（恰一次 `retryKbRebuild`）。更换嵌入模型名称或上游地址且知识库数大于 0 时，保存 SHALL 先弹确认（拷入层 alert-dialog，正文 `更换嵌入模型会重建全部 <知识库数> 个知识库（共 <文档数> 份文档），重建期间不能入库。`，按钮 `取消` / `重建并保存`），确认后带 `confirmRebuild:true` 恰调用一次 `updateKbSettings`；取消则不发请求。设置读取失败时该段显示 `知识库服务暂不可用` 与 `重试`。API 客户端 `web/src/lib/api-models.ts` SHALL 提供 `listModels` / `createModel(input)` / `updateModel(id, input)` / `deleteModel(id)` / `setDefaultModel(id)` / `probeModel(id)`，查询参数 `id` 经 `encodeURIComponent`，响应按 `ModelView` 严格解析（键集与类型不符即 `requestFailed`），`api.ts` 导出其类型。

#### Scenario: 登记、编辑与探活
- **WHEN** 管理员点 `新增模型`，填 `id` `m2`、勾 `推理`、勾 `low` `high`、填地址与密钥，提交（假客户端返回视图）；随后编辑 `m2` 只改 `name`；再编辑改地址不填密钥
- **THEN** 第一次 `createModel` 的 input 恰为 `{id:"m2", reasoning:true, efforts:["low","high"], upstream:{baseUrl, apiKey}}`（未碰的键不发），随后恰一次 `probeModel("m2")`；第二次 `updateModel` 的 input 含 `upstream:{baseUrl}`（不含 `apiKey`）且没有探活；第三次有探活；每次成功后恰一次 `listModels`

#### Scenario: 删除与缺省
- **WHEN** 管理员对非缺省行点 `删除` 并确认；对另一行点 `设为缺省`；`deleteModel` 返回 409 信封
- **THEN** 确认后恰一次 `deleteModel`；`设为缺省` 恰一次 `setDefaultModel`，刷新后该行有 `缺省` 标记且不再有 `设为缺省` 按钮；409 时行内显示信封文案、行仍在

#### Scenario: 开编译的库锁定对话模型下拉
- **WHEN** 知识库设置为 `{chatModelId:"m2", compileBases:1, …}`；另一次为 `{chatModelId:"m2", compileBases:0, …}`；再一次为 `{chatModelId:null, compileBases:1, …}`
- **THEN** 第一次下拉禁用，旁注含 `1 个开启 RAPTOR 或知识图谱的知识库`；后两次下拉可用，没有该旁注

#### Scenario: 更换嵌入模型需确认
- **WHEN** 知识库设置为 `{embedding:{name:"bge-m3", …}, bases:2, documents:5, …}` 时管理员把名称改为 `text-embedding-3-small` 并保存，在确认框点 `取消`；再保存并点 `重建并保存`
- **THEN** 确认框正文含 `2 个知识库（共 5 份文档）`；取消后没有 `updateKbSettings` 请求；确认后恰一次 `updateKbSettings`，其 input 含 `confirmRebuild:true`，随后恰一次 `probeKbModel("embedding")`

#### Scenario: 重排模型
- **WHEN** 知识库设置为 `{rerank:null, bases:2, …}` 时管理员点重排模型一行的 `编辑`，填名称、地址与密钥保存；随后设置为 `{rerank:{name:"qwen3-rerank", …}, …}`，点 `探活`；再点 `清除`，在确认框先点 `取消`，再点 `清除` 并确认
- **THEN** 保存恰一次 `updateKbSettings`，input 恰为 `{rerank:{name, baseUrl, apiKey}}`，没有重建确认框，随后恰一次 `probeKbModel("rerank")`；`探活` 恰一次 `probeKbModel("rerank")`；取消后没有请求；确认后恰一次 `updateKbSettings({rerank:null})`
