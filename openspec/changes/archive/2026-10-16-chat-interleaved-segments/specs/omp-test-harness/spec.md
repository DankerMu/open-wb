## ADDED Requirements

### Requirement: 受控上游交错标记
受控假上游 `server/test/support/fake-upstream.mjs` SHALL 支持标记 `WORKBUDDY_INTERLEAVE`：最后一条 user 文本含它、该请求是答复轮（不是工具轮）且没有已武装的闸门时，答复轮按 `WORKBUDDY_PACE` 的同一节奏写法（每条记录单独写出、相隔 25ms，复用 `fake-upstream-pace.mjs` 的写出逻辑）依次写出：角色帧、正文片 `先说一句，`、正文片 `再补一句。`、思考片 `想一想`（`reasoning_content`）、正文片 `然后作答。`、finish、`[DONE]`。由此第二片正文在第一片的 250ms 时间窗内到达、会被合并器缓冲，紧接着到达的思考片使「合并器缓冲着正文时开段」在真实链路上出现（chat-stream「分段位置的记录与下发」）。

- 同带 `WORKBUDDY_PACE` 时以 `WORKBUDDY_PACE` 为准，本标记不生效；同带 `WORKBUDDY_THINK` 或 `WORKBUDDY_THINK_LONG` 时不再另发它们的思考片；
- 带已武装闸门时忽略本标记，闸门行为逐字节不变；
- 不带本标记的请求逐字节不变；工具轮不受影响；
- 连接中途关闭时停止写出，不抛未处理异常（同 `WORKBUDDY_PACE`）。

#### Scenario: 交错写出
- **WHEN** 一个答复轮请求的最后一条 user 文本含 `WORKBUDDY_INTERLEAVE`
- **THEN** 响应的数据记录依次为角色帧、`先说一句，`、`再补一句。`、`reasoning_content` 为 `想一想` 的一帧、`然后作答。`、finish 与 `[DONE]`，服务端相邻两次写出的间隔不小于 20ms，每次写出时响应对象的 `writableCorked` 为 0

#### Scenario: 不改变其它请求
- **WHEN** 请求不含该标记；或同带 `WORKBUDDY_PACE`；或带已武装的闸门；或是工具轮
- **THEN** 前三者的输出分别与本 change 之前、与只带 `WORKBUDDY_PACE`、与只带闸门标记时逐字节相同；工具轮照常只发一个工具调用
