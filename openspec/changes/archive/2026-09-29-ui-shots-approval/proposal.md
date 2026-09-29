# Proposal: ui-shots-approval（#618）

```text
Issue type: bugfix
Fixture level: compact
Upstream suggested level: absent (agree: 单脚本单函数 + 一处 spec 措辞)
Blast radius: 作答步骤写错 → chat-done 仍靠 60s 自动允许或超时，`make ui-shots` 仍非零、demo-parity 签收无产物
Selected risk packs: Legacy compatibility; Documentation
Evidence floor: 真 omp v18.0.10（SHA256 校验）+ 编译产物服务 + `.github/scripts/ci-fake-upstream.sh` 假上游、fresh DB、夹具就位：`make ui-shots` 退出 0、恰 60 PNG + index.html、首格 chat-done 远早于 60s；lint；openspec validate --strict
```

design.md omitted (compact).

## Why
#617 把生产 argv 切到 `--approval-mode write` 后，假上游首轮必回一个 bash tool call（`server/test/support/fake-upstream.mjs:112-116`），真 omp 对它发审批 select 并挂起。`web/e2e/ui-shots.mjs` 的 `createDoneSession`（`:263-277`）发送固定提示后只等 `已完成|失败` 60s（`CHAT_DONE_TIMEOUT_MS`），而自动允许也要 60s 且之后还要再走一轮上游，所以首格 chat-done 必然超时，其余 5 格依赖它，结果只有 54/60 张、退出码 1。

## What Changes
- `createDoneSession`：发送后在助手 article 内等 group `需要你的确认` 可见，点其中 button `允许`（exact），等 group `已允许执行` 可见，再沿用现有 `已完成|失败` 等待。用脚本已有的 `visible()`/`pollUntil()`；不 import `@playwright/test` 的 `expect` 或 `web/e2e/ui-walk-approval.ts`（纯 `.mjs`），只复用其可访问名与步骤。
- 如果回合未产生审批（调用方自有真实上游可能不调工具），直接进入既有等待，不因缺少审批条失败。
- `CHAT_DONE_TIMEOUT_MS` 不变。
- spec：demo-parity-acceptance MODIFIED「ui-shots 截图对产物」，chat-done 描述补上作答审批一步。

## Capabilities
- MODIFIED demo-parity-acceptance「ui-shots 截图对产物」。

## Impact
- `web/e2e/ui-shots.mjs`（仅 `createDoneSession` 附近）。app 侧 `chat-done` 截图从此多一条 `已允许执行` 审批条（demo 没有），由 #654 的验收清单注明。
