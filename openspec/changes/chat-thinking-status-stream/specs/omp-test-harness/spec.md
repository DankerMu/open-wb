## ADDED Requirements

### Requirement: 受控上游节奏与闸门停点标记
受控上游 `server/test/support/fake-upstream.mjs` SHALL 另识别两个标记，查找方式与「受控上游思考与写入标记」相同（最后一条 user 文本的子串），可与该要求的标记及 `WORKBUDDY_UI_WALK:<uuid>` 组合：
- `WORKBUDDY_PACE`：答复轮（与 `WORKBUDDY_THINK` 的轮次判定相同）SHALL 在角色帧之后，先发与 `WORKBUDDY_THINK` 相同的三个 `reasoning_content` 分片（`先读需求，`、`再列要点，`、`最后作答。`），再发恰 40 个 `content` 分片，每个分片的 `content` 为一个 `字`（拼接恰为 40 个 `字`），相邻两个分片（含第一个思考分片与角色帧之间）间隔 25ms，然后是 finish 与 `[DONE]`；它取代该轮的固定答复。同带 `WORKBUDDY_THINK` 时不重复发思考分片。工具轮不受影响。带已武装闸门时 `WORKBUDDY_PACE` 被忽略（闸门行为优先，逐字节同不带 `WORKBUDDY_PACE`）。
- `WORKBUDDY_HOLD_AT:<point>`：只在该请求带已武装闸门时生效。`<point>` 为 `empty` 时，停住之前只发角色帧，思考分片（带 `WORKBUDDY_THINK` 时）与全部答复分片在放行时发出；为 `thinking` 时，停住之前发角色帧与思考分片（须同带 `WORKBUDDY_THINK`，否则同 `empty`），全部答复分片在放行时发出。取值不是这两者、或请求没有已武装闸门时，SHALL 与不带该标记逐字节相同（今天的停点：第一段答复之后）。放行与闸门的其余规则（单次放行、TTL、容量、409）不变。
不带这两个标记的请求 SHALL 与本要求之前逐字节相同。

#### Scenario: 节奏标记
- **WHEN** 一个答复轮请求的最后一条 user 文本含 `WORKBUDDY_PACE`，不带闸门
- **THEN** 流为角色帧、三个 `reasoning_content` 分片、40 个各为 `字` 的 `content` 分片、finish、`[DONE]`；相邻分片的到达间隔不小于 20ms，首末分片相隔不小于 1000ms
- **WHEN** 同一请求还带已武装闸门
- **THEN** 流与不带 `WORKBUDDY_PACE` 的闸门请求逐字节相同（生成的 id 与时间戳除外）

#### Scenario: 闸门停点
- **WHEN** 带已武装闸门的答复轮请求分别含 `WORKBUDDY_HOLD_AT:empty`；含 `WORKBUDDY_THINK` 与 `WORKBUDDY_HOLD_AT:thinking`；含 `WORKBUDDY_HOLD_AT:middle`
- **THEN** 第一例停住前只收到角色帧，放行后收到全部答复分片、finish 与 `[DONE]` 各恰一次；第二例停住前收到角色帧与三个思考分片，放行后收到全部答复分片；第三例与不带停点标记的闸门请求逐字节相同
- **WHEN** 不带闸门的请求含 `WORKBUDDY_HOLD_AT:empty`
- **THEN** 流与不带该标记逐字节相同

#### Scenario: 官方 omp 上的合并取证
- **WHEN** `WORKBUDDY_OMP_TEST=1` 下，经官方 omp v18.0.10、model-proxy 与本受控上游，发送含 `WORKBUDDY_PACE` 的 prompt 并读取该回合发布的事件
- **THEN** `text.delta` 拼接恰为 40 个 `字` 且条数少于 40、不多于 7；第一条 `text.delta` 的发布不晚于第一段正文到达之后的同一次处理（不经 250ms 等待）；`thinking.delta` 拼接恰为 `先读需求，再列要点，最后作答。`；恰有一条 `thinking.end`，位于第一条 `text.delta` 之前；回合结束后快照该助手消息 `thinkingMs` 为非负整数
