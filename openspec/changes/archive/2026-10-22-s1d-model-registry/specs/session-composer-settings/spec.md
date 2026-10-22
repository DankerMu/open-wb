# session-composer-settings Spec Delta

> s1d-model-registry：「输入框选项端点」的 `models` 与 `defaults` 改读注册表快照；body 形状不变（恰四键，模型项键集不变）。其余 requirement 逐字沿用主规格。

## MODIFIED Requirements

### Requirement: 输入框选项端点
sessions 模块 SHALL 注册 `GET /api/composer/options`，受既有 cookie guard 保护（未认证 401），响应 `Cache-Control: no-store`；它不读取任何会话，不接受查询参数。200 的 body SHALL 恰含四个键：

- `approvalModes`：按 `always-ask`、`write`、`yolo` 的次序列出不高于 `APPROVAL_MAX_MODE` 的档位（至少一项）。
- `models`：按注册表快照次序（model-registry「注册表快照是白名单的唯一来源」；每次请求读当时的快照，不缓存），每项恰为 `{id, name, reasoning, vision, efforts, defaultEffort}`；`efforts` 是该模型的可选强度（model-selection「推理强度集合」：`off` 加所声明的强度，`efforts` 列为 NULL 的种子项为 `off` 加全部六档；不支持推理时为 `[]`；其中没有 `auto`），`defaultEffort` 是其缺省强度（不支持推理时为 `null`）。
- `defaults`：`{approvalMode, modelId, reasoningEffort}`，为请求账号 `account_composer_prefs` 行（没有则三者为 null）经「有效值解析」得到的值。
- `upload`：`{maxBytes, maxFiles}`，即 `UPLOAD_MAX_BYTES` 与 `UPLOAD_MAX_FILES` 的生效值。

响应 SHALL NOT 含上游地址、密钥或任何其它配置。

#### Scenario: 缺省配置
- **WHEN** 在空库上以零配置启动（六个模型键都未设置，种子为单模型 `deepseek-v4.1-flash`，model-registry「环境种子」），一个从未做过选择的账号请求该端点
- **THEN** 200 且 body 恰为 `{approvalModes:["always-ask","write","yolo"], models:[{id:"deepseek-v4.1-flash", name:"deepseek-v4.1-flash", reasoning:true, vision:true, efforts:["off","minimal","low","medium","high","xhigh","max"], defaultEffort:"high"}], defaults:{approvalMode:"write", modelId:"deepseek-v4.1-flash", reasoningEffort:"high"}, upload:{maxBytes:524288000, maxFiles:10}}`，带 no-store

#### Scenario: 封顶、白名单与账号各自的缺省
- **WHEN** `APPROVAL_MAX_MODE=write`、注册表为前述三项（种子或登记）、`UPLOAD_MAX_BYTES=1048576`、`UPLOAD_MAX_FILES=3`；账号甲的最近选择为 `yolo`、`m3`、`low`，账号乙没有最近选择；两个账号各请求一次；匿名请求一次
- **THEN** 两个账号的 `approvalModes` 都是 `["always-ask","write"]`，`models` 恰三项且 `m2` 的 `efforts` 为 `[]`、`defaultEffort` 为 `null`，`m1` 的 `efforts` 为 `["off","minimal","low","medium","high","xhigh","max"]`，`m3` 的 `efforts` 为 `["off","low","high"]`；甲的 `defaults` 为 `{write,m3,low}`，乙的为 `{write,m1,high}`；`upload` 为 `{maxBytes:1048576, maxFiles:3}`；匿名请求 401

#### Scenario: 注册表写入后立即变化
- **WHEN** 账号乙先请求一次得到 `models` 恰一项；管理员随后登记 `m2` 并设为缺省；乙与最近选择为种子模型的账号甲各再请求一次
- **THEN** 两人的 `models` 都恰两项且 `m2` 在后；乙的 `defaults.modelId` 为 `m2`，甲的仍为种子模型；服务没有重启
