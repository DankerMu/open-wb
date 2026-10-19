# Spec Delta

## MODIFIED Requirements

### Requirement: 输入框选项端点
sessions 模块 SHALL 注册 `GET /api/composer/options`，受既有 cookie guard 保护（未认证 401），响应 `Cache-Control: no-store`；它不读取任何会话，不接受查询参数。200 的 body SHALL 恰含四个键：

- `approvalModes`：按 `always-ask`、`write`、`yolo` 的次序列出不高于 `APPROVAL_MAX_MODE` 的档位（至少一项）。
- `models`：按白名单次序，每项恰为 `{id, name, reasoning, vision, efforts, defaultEffort}`；`efforts` 是该模型的可选强度（model-selection「推理强度集合」：`off` 加所声明的强度，`MODEL_CATALOG` 未设置时的那一项为 `off` 加全部六档；不支持推理时为 `[]`；其中没有 `auto`），`defaultEffort` 是其缺省强度（不支持推理时为 `null`）。
- `defaults`：`{approvalMode, modelId, reasoningEffort}`，为请求账号 `account_composer_prefs` 行（没有则三者为 null）经「有效值解析」得到的值。
- `upload`：`{maxBytes, maxFiles}`，即 `UPLOAD_MAX_BYTES` 与 `UPLOAD_MAX_FILES` 的生效值。

响应 SHALL NOT 含上游地址、密钥或任何其它配置。

#### Scenario: 缺省配置
- **WHEN** 四个新环境变量与 `MODEL_CATALOG` 都未设置、`MODEL_ID`、`MODEL_REASONING` 与 `MODEL_VISION` 取缺省（`MODEL_VISION` 缺省 `on`，model-selection「模型白名单配置」，#912），一个从未做过选择的账号请求该端点
- **THEN** 200 且 body 恰为 `{approvalModes:["always-ask","write","yolo"], models:[{id:"deepseek-v4.1-flash", name:"deepseek-v4.1-flash", reasoning:true, vision:true, efforts:["off","minimal","low","medium","high","xhigh","max"], defaultEffort:"high"}], defaults:{approvalMode:"write", modelId:"deepseek-v4.1-flash", reasoningEffort:"high"}, upload:{maxBytes:524288000, maxFiles:10}}`，带 no-store

#### Scenario: 封顶、白名单与账号各自的缺省
- **WHEN** `APPROVAL_MAX_MODE=write`、白名单为前述三项、`UPLOAD_MAX_BYTES=1048576`、`UPLOAD_MAX_FILES=3`；账号甲的最近选择为 `yolo`、`m3`、`low`，账号乙没有最近选择；两个账号各请求一次；匿名请求一次
- **THEN** 两个账号的 `approvalModes` 都是 `["always-ask","write"]`，`models` 恰三项且 `m2` 的 `efforts` 为 `[]`、`defaultEffort` 为 `null`，`m1` 的 `efforts` 为 `["off","minimal","low","medium","high","xhigh","max"]`，`m3` 的 `efforts` 为 `["off","low","high"]`；甲的 `defaults` 为 `{write,m3,low}`，乙的为 `{write,m1,high}`；`upload` 为 `{maxBytes:1048576, maxFiles:3}`；匿名请求 401
