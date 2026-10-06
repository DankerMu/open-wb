# 修「新建会话」在首次发送交接期间的判定（#872）

## Why

侧栏「新建会话」在首次发送的「创建—发送」交接尚未落定时不应导航，否则会中止随后的 prompt，留下一个没有消息的会话。当前判定依赖「prompt 请求的控制器已建立」，有一个窗口放行：创建请求已返回、地址栏已带新会话 id，而 prompt 尚未派发。规格括注写的是「创建请求或其后的那一次 prompt 请求在途」，既没有覆盖这个窗口，也与实现实际拦到的范围不一致。

## What Changes

- 判定改为基于状态：欢迎态首次发送登记的那次交接仍归当前页面所有、且 prompt 尚未被受理或拒绝时，「新建会话」不导航、不中止交接。prompt 已受理（之后的快照读取成功与否都算落定）或被拒绝后，「新建会话」照常可用。
- 行为变化一处：prompt 已受理、历史读取仍在途时点击「新建会话」，现在会回到欢迎态（此前拦到读取结束）。此时会话已有消息，不会留下空会话。
- 补测试：判定的状态表；创建已返回而 prompt 未派发时点击不导航，且恰有一次未被中止的 prompt；prompt 已受理后（历史读取在途或失败）点击能回到欢迎态。
- 订正 session-sidebar 规格的括注与场景。

## Fixture

- Fixture level: compact
- Risk packs: state-machine（创建—发送交接）
- Must preserve: 「新建会话」的其余行为（清除 `?session=`、不发请求、草稿不变、焦点规则）；首次发送恰一次创建、恰一次 prompt；交接在途时切换到别的会话条目或浏览器后退的现有行为不变（owner 2026-10-06 决定不纳入）。
- Required evidence: tasks 1.2–1.4 的测试与 1.5 的三条变异；`make check`、`make test-guardrails`、ui-walk 通过。

## Impact

`web/src/features/chat/ownership.ts`（判定纯函数）、`types.ts`（登记加「已受理」标记）、`use-chat-session.ts`（「新建会话」改用该判定）、`turn-actions.ts`（受理处置位）；对应测试；`openspec/specs/session-sidebar/spec.md`。不涉及外壳与会话列表组件。
