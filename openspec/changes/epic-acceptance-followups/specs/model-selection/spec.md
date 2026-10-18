# Spec Delta

## MODIFIED Requirements

### Requirement: 模型白名单配置
服务端 SHALL 持有一份启动时确定、此后不变的模型白名单：一个有序的模型列表与其中一个缺省模型。每个模型为 `{id, name, reasoning, vision, maxTokens, efforts?}`：`id` 是发给上游的模型名（也是托管 `models.yml` 条目的 `id`）；`name` 是界面显示名；`reasoning` 表示支持推理；`vision` 表示支持看图；`maxTokens` 是该模型单次回复的输出上限（写进托管 `models.yml` 的 `maxTokens`，omp 以它作上游请求的 `max_tokens`；owner 2026-10-18 裁决：按模型可配，缺省 32768）；`efforts` 是该模型支持的推理强度子集（推理模型必带，`MODEL_CATALOG` 未设置时的那一项除外；`reasoning` 不为真的模型不带）。
白名单由 `agent-config.ts` 的同一个 resolver 从环境变量得出，全部校验 SHALL 先于任何文件系统、数据库或监听动作；配置错误 SHALL 使启动失败，错误信息只点名出错的键、不回显取值：

- `MODEL_CATALOG` **未设置**：白名单恰一项 `{id:<MODEL_ID 的生效值>, name:<同一个值>, reasoning:<MODEL_REASONING 的生效值>, vision:false, maxTokens:32768}`，它就是缺省模型，不带 `efforts`。除 `maxTokens`（此前固定 8192）外与最初的单模型配置相同。
- `MODEL_CATALOG` **已设置**：SHALL 是一个 JSON 文本，解析为含 1 到 32 个元素的数组；每个元素是对象，键集为 `{id, name, reasoning, vision, maxTokens, efforts}` 的子集且必须含 `id`。`id` 为 1 到 128 个 UTF-8 字节、不含 U+0000–U+001F 与 U+007F 的字符串，各项互不相同；`name` 为 1 到 64 个 Unicode 码点、不含同一组控制字符的字符串，缺省等于 `id`；`reasoning` 与 `vision` 为布尔，缺省 `false`；`maxTokens` 为 1 到 128000 的整数（上限即托管 `models.yml` 对每个模型固定的 `contextWindow`），缺省 32768；
  `reasoning` 为 `true` 的元素 SHALL 带 `efforts`，`reasoning` 不为 `true` 的元素 SHALL NOT 带它；`efforts` 为 `minimal`、`low`、`medium`、`high`、`xhigh`、`max` 的非空子集，元素不重复且按这一强度次序升序排列。空串、非 JSON、非数组、空数组、超过 32 项、多余键、类型不符、`id` 重复、`reasoning` 不为真却带 `efforts`、`reasoning` 为真却不带 `efforts`、`maxTokens` 不是整数或不在 1 到 128000 之内，均为启动失败并点名 `MODEL_CATALOG`。
  此时 `MODEL_ID` 若设置 SHALL 等于某一项的 `id`，该项为缺省模型，否则启动失败并点名 `MODEL_ID`；`MODEL_ID` 未设置时第一项为缺省模型。`MODEL_REASONING` SHALL NOT 与 `MODEL_CATALOG` 同时设置，同设即启动失败并点名 `MODEL_REASONING`。

白名单 SHALL 是界面可选模型的唯一来源（`GET /api/composer/options`；该端点的模型项 SHALL NOT 带 `maxTokens`——上限只进托管 `models.yml`）、会话设置校验与有效值解析的依据（session-composer-settings），以及托管 `models.yml` 的输入（model-proxy「托管 models.yml」）。所有白名单模型共用同一个上游（`MODEL_UPSTREAM_BASE_URL` / `MODEL_UPSTREAM_API_KEY`）；白名单同时是模型代理放行的 `model` 取值集合：请求体里的模型名不在白名单内的请求被代理拒绝、不到达上游，规则只由 model-proxy「透传端点与 bearer 鉴权」的 Model whitelist 一段规定，本条不复述。

#### Scenario: 未配置白名单等于单模型
- **WHEN** `MODEL_CATALOG` 未设置，分别以 `MODEL_ID`、`MODEL_REASONING` 均未设置，以及 `MODEL_ID=qwen-x`、`MODEL_REASONING=off` 解析配置
- **THEN** 前者白名单恰为 `[{id:"deepseek-v4.1-flash", name:"deepseek-v4.1-flash", reasoning:true, vision:false, maxTokens:32768}]`；后者恰为 `[{id:"qwen-x", name:"qwen-x", reasoning:false, vision:false, maxTokens:32768}]`；两者的缺省模型都是那唯一一项

#### Scenario: 多模型白名单与缺省模型
- **WHEN** `MODEL_CATALOG` 为 `[{"id":"m1","name":"通用","reasoning":true,"efforts":["minimal","low","medium","high","xhigh","max"]},{"id":"m2","maxTokens":8192},{"id":"m3","name":"深度","reasoning":true,"vision":true,"efforts":["low","high"]}]`，分别以 `MODEL_ID` 未设置与 `MODEL_ID=m3` 解析
- **THEN** 白名单为三项且次序不变，`m2` 的 `name` 为 `m2`、`reasoning` 与 `vision` 为 `false`、`maxTokens` 为 8192 且不带 `efforts`，`m1` 与 `m3` 的 `efforts` 为所给的数组、`maxTokens` 为 32768；缺省模型分别为 `m1` 与 `m3`

#### Scenario: 非法白名单使启动失败
- **WHEN** `MODEL_CATALOG` 分别为空串、`not json`、`{}`、`[]`、含 33 项的数组、`[{"name":"x"}]`、`[{"id":""}]`、`[{"id":"a"},{"id":"a"}]`、`[{"id":"a","extra":1}]`、`[{"id":"a","reasoning":"yes"}]`、`[{"id":"a","reasoning":true}]`、`[{"id":"a","efforts":["low"]}]`、`[{"id":"a","reasoning":true,"efforts":[]}]`、`[{"id":"a","reasoning":true,"efforts":["high","low"]}]`、`[{"id":"a","reasoning":true,"efforts":["ultra"]}]`、`[{"id":"a","reasoning":true,"efforts":["auto"]}]`、`[{"id":"a","maxTokens":0}]`、`[{"id":"a","maxTokens":128001}]`、`[{"id":"a","maxTokens":1.5}]`、`[{"id":"a","maxTokens":"32768"}]`、`[{"id":"a","maxTokens":null}]`、`[{"id":"a","maxTokens":-1}]`
- **THEN** 每一个都在任何文件系统、数据库或监听动作之前启动失败，错误信息含 `MODEL_CATALOG` 而不含所给取值
- **WHEN** `MODEL_CATALOG` 合法而 `MODEL_ID=other`（不在其中）；另一例 `MODEL_CATALOG` 合法且同时设置了 `MODEL_REASONING=on`
- **THEN** 分别启动失败并点名 `MODEL_ID` 与 `MODEL_REASONING`
- **WHEN** `MODEL_CATALOG` 分别为 `[{"id":"a","maxTokens":1}]` 与 `[{"id":"a","maxTokens":128000}]`
- **THEN** 两者都解析成功，白名单恰一项，`maxTokens` 分别为 1 与 128000（边界值包含在内）
