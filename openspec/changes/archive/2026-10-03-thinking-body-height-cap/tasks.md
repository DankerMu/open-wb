# Tasks: thinking-body-height-cap（#725）

Fixture level: compact

归档次序（前提）：本 change 先归档进主规格；父 change `s1c-session-metadata-presentation` 的 thinking-fold delta 仍是旧文，归档前按 #754 从主规格现文重新生成全部 delta。本 PR 不改父 delta。

## 1. 实现
- [x] 1.1 `thinking-block.tsx`：`<details>` 在 `running` 为真时带 `data-running` 属性（假时不带该属性）；`open` 的写法与「React 只在 running 变化时写 open」的性质不变。
- [x] 1.2 `messages.css`：`.thinking-block:not([data-running]) .thinking-body { max-height: 12rem; overflow: auto; }`，注释说明与 demo:539-545 的偏离及原因（注释里写 `issue 725`：`(#725)` 会被颜色守卫当成 hex 字面量）。其余 `.thinking-*` 规则不动。
- [x] 1.3 `web/test/chat-thinking.test.tsx`：T6（流式 → turn.end）补断言 running 时有 `data-running`、终态后没有；T7（快照 done）补断言没有；仿 T11/T12 的 `ruleBody` 静态断言：`.thinking-block:not([data-running]) .thinking-body` 规则含 `max-height: 12rem` 与 `overflow: auto`，且 `.thinking-body` 规则不含 `max-height`。
- [x] 1.4 `web/e2e/ui-walk-sessions.spec.ts` `step4ThinkingFold`：展开后断言 `.thinking-body` 的计算样式 `max-height` 为 `192px`、`overflow-y` 为 `auto`，且 `<details>` 不带 `data-running`。
- [x] 1.5 不改其它被跟踪文件（除本 change 目录）。

## Must preserve
- `web/test/chat-thinking.test.tsx` 既有 T6–T8、F1–F4 断言不动且全绿（手动切换保留）。
- 既有 ui-walk 全绿（`walkScrollFollow` 的贴底断言不变）。

## Required evidence
- E1 `npm test --workspace web` 全绿（文件数/测试数；基线 86 / 1796，先量一次）。
- E2 `make ui-walk`（CI wrapper，假上游）全绿，含 1.4 的断言。
- E3 真实浏览器一次性脚本（不入库，产物留在 issue 目录）：路由级 API mock，120 行 thinking 的 done 消息，390×844 与 1440×900，转录贴底后点击 summary——记录点击前后 距底 / summary 距滚动容器顶 / 主体 `clientHeight` 与 `scrollHeight`；期望 距底 ≤4、summary 可见、主体 192px 且可滚到末行。同脚本在未贴底（距底 100px）时展开：`scrollTop` 不变。同一脚本对改动前的构建跑一次作对照（复现 issue 表第一、二行）。
- E4 真实浏览器：running 消息 thinking 增长到 120 行（一次性脚本自带分段推送的 SSE 源或替换 `EventSource`；假上游只发三个思考分片，不够）——主体无盒内滚动、转录贴底跟随；`turn.end` 后属性消失、折叠块收起。
- E5 `make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh`、`openspec validate thinking-body-height-cap --strict --no-interactive` exit 0。

## Negative controls
- N1 去掉 CSS 规则 → 1.4 失败、E3 复现位移。
- N2 选择器去掉 `:not([data-running])`（全量限高）→ 1.3 的静态断言与 E4 的「无盒内滚动」失败。
- N3 `data-running` 恒带 → 1.3 的终态断言与 1.4 失败。

## Risk packs
| Pack | Selected | 理由 → 证据 |
|---|---|---|
| UI state / layout / responsive | yes | 两个视口的展开位移 → E3、E4、1.4 |
| Regression of adjacent behaviour | yes | 折叠态规则与贴底跟随不变 → Must preserve、E2 |
| 其它 | no | 无 API、数据、依赖改动 |
