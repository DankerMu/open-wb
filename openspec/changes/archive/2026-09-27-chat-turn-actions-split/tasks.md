# Tasks: chat-turn-actions-split（#489）

## 7. chat-web 纯搬迁（父 tasks 7.0b 原文）

- [ ] 7.0b 纯搬迁、行为不变：`web/src/features/chat/page.tsx`（734 行）拆出 `web/src/features/chat/turn-actions.ts`（stop/regenerate/fork/approval 的 handler 与 fence 落点，先搬既有 prompt handler/fence 辅助）；`stream.ts` 不在本刀拆分，审批归约落在 5.3 新建的 `web/src/features/chat/stream-approvals.ts`。验证：`bash scripts/size-guard.sh` 退出 0、web 既有测试不改动全绿、`knip` 零新增

> 本刀只搬 `page.tsx:314-447` 的 prompt 派发簇，并把 `:29` 的常量一并移入；留在原处的部分与理由见 proposal 偏离 1。搬迁清单与胶水边界见 design「Must add/change」。

- [ ] S1 形状：
  - `git diff --stat ${BASE} -- web server` 恰好列出 `web/src/features/chat/{page.tsx,turn-actions.ts}` 两个文件；本 child change 目录随同一 PR 提交，不计入此项；
  - `wc -l` 依次为 620、210，偏差 ±3 行以内；偏差更大须在 PR body 说明；
  - `page.tsx` ≤ 623 行。
- [ ] S2 搬迁恒等：D1、D2、D4 输出为空，两处 DEPS 计数均为 4，D3 恰好输出下面 4 行。在仓库根目录用 bash 运行。`BASE=56fc402a0b31fec517f9334e2f91869d76c6a025`。
  ```sh
  F=web/src/features/chat
  norm() { tr -d '[:space:]' | sed -E 's/\},\[[A-Za-z,]*\],?\)/},[DEPS])/g'; }
  # D1：块体恒等。去掉空白并把依赖数组归一为 [DEPS] 后比较，两侧各恰有 4 处 [DEPS]
  diff <(git show ${BASE}:$F/page.tsx | sed -n '314,447p' | norm) \
       <(awk '/^}: TurnActionDeps\) \{$/{f=1;next} /^  return \{ dispatchPrompt, restoreOwnedDraft \};$/{f=0} f' $F/turn-actions.ts | norm)
  # D2：page.tsx 其余部分恒等；搬迁块与 hook 调用都替换为占位行，所以位置也被直接校验
  diff <(git show ${BASE}:$F/page.tsx | sed -e '29d' -e '314,447c\
__TURN_ACTIONS__') \
       <(sed -e '/^import { TERMINAL_REFRESH_GUIDANCE, useTurnActions } from "\.\/turn-actions\.js";$/d' \
             -e '/= useTurnActions({$/,/^  });$/c\
__TURN_ACTIONS__' $F/page.tsx)
  # D1 补充：两侧各恰 4 处 [DEPS]（D1 的 diff 为空不能单独证明这一点）
  git show ${BASE}:$F/page.tsx | sed -n '314,447p' | norm | grep -o DEPS | wc -l   # 期望 4
  awk '/^}: TurnActionDeps\) \{$/{f=1;next} /^  return \{ dispatchPrompt, restoreOwnedDraft \};$/{f=0} f' $F/turn-actions.ts | norm | grep -o DEPS | wc -l   # 期望 4
  # D4：调用实参与 hook 形参逐项同名（18 个同名简写，无 `a: b` 重绑定），输出须为空
  diff <(sed -n '/= useTurnActions({$/,/^  });$/p' $F/page.tsx | sed '1d;$d;s/^ *//;s/,$//') \
       <(sed -n '/^export function useTurnActions({$/,/^}: TurnActionDeps) {$/p' $F/turn-actions.ts | sed '1d;$d;s/^ *//;s/,$//')
  # D3：依赖数组逐项核对（相对 base 只补入 ref 对象与 setter，无 .current）
  tr -d '[:space:]' < $F/turn-actions.ts | grep -oE '\},\[[A-Za-z,]*\],?\)'
  ```
  D3 期望输出：
  ```text
  },[clientRef,requestedSessionRef,setDraft],)
  },[pendingCreateSendRef,setCreating,setMutationOwner,setSubmitting],)
  },[clientRef,finishCreateSend,mountedRef,mutationGenerationRef,pendingCreateSendRef,releaseMutationIfOwned,restoreOwnedDraft,setPromptError,setStreamError,setSubmitting,],)
  },[abortMutation,clientRef,closeSource,failOwnedPrompt,finishCreateSend,installSnapshot,mountedRef,mutationControllerRef,mutationGenerationRef,openSource,pendingCreateSendRef,refreshList,releaseMutationIfOwned,requestedSessionRef,setMutationOwner,setPromptError,setSubmitting,],)
  ```
  D3 与 base 对应数组的差集只能是 ref 对象与 setter。base 的四个数组依次为 `[]`、`[]`、`[finishCreateSend, releaseMutationIfOwned, restoreOwnedDraft]` 与 8 项的 `dispatchPrompt` 数组（437-446）。
- [ ] S3 模块边界：以下各项全部满足。
  - `grep -cE '\buse(Effect|LayoutEffect|State|Ref|Memo|Reducer)\b' $F/turn-actions.ts` 为 0，`grep -c 'useCallback(' $F/turn-actions.ts` 为 4；
  - `grep -c 'page.js' $F/turn-actions.ts` 为 0；`grep -rln 'turn-actions' web/src web/test` 只有 `web/src/features/chat/page.tsx`；
  - `grep -n '^export' $F/turn-actions.ts` 恰为 `TERMINAL_REFRESH_GUIDANCE` 与 `useTurnActions` 两个；`grep -n '^import' $F/turn-actions.ts` 恰为 design 所列的 5 行；
  - `git diff ${BASE} -- $F/index.ts` 为空，`grep -n '^export' $F/page.tsx` 仍只有 `ChatPage`。
- [ ] S4 回归：
  - `git diff --stat ${BASE} -- web/test` 为空；
  - `npm test --workspace web` 全绿，且为 55 文件 / 1080 例，与 base 相同；按 `.tool-versions` 用 Node 24.13.1 运行；
  - 覆盖率门禁为全局 80%。全局 stmts/branch/funcs 不低于 base 的 96.26/91.68/99.49。镜像实测 `turn-actions.ts` 的未覆盖语句与分支和 base `page.tsx` 314-447 中的逐一对应，没有新增未覆盖项；
  - 页面级套件零 diff 全绿，其中关键用例如下：
    - `chat-page-ownership.test.tsx`：228 502/409、258 受理后快照失败、282/316 刷新指引；
    - `chat-page-lifecycle.test.tsx`：170/217 草稿保留、323 并发提交；
    - `chat-page-ownership-gaps.test.tsx`：50/178/267/360；
    - `topbar.test.tsx`：262/285 源码文本守卫。

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Concurrency / shared state / ordering | yes | generation/abort/client/requested-session 门控随搬迁跨文件；依赖数组改为显式列出稳定引用；hook 调用位置 → 只由 S2 D2（占位行替换，直接校验位置）守护。`useTurnActions` 只含 `useCallback`，移位没有行为效应，既有测试看不到它的位置（PR #609 评审中的信息性变异已证实）；fence 门控的漂移由 D1 与 `chat-page-lifecycle.test.tsx`/`chat-page-ownership-gaps.test.tsx` 零 diff 全绿守护 |
| Legacy compatibility / examples | yes | `index.ts:1` 导出面、`router.tsx:4` 与 `chat-page-lifecycle-support.tsx:7` 导入方、`topbar.test.tsx:285-287` 源码守卫不变 → S3 + S4 + `make typecheck` |
| Error handling / rollback / partial outputs | yes | 受理前失败要恢复草稿并显示 promptError，受理后失败只给 streamError 加刷新指引 → S2 + `chat-page-ownership.test.tsx:228,258,282,316`、`chat-page-lifecycle.test.tsx:170,217` 零 diff 全绿 |
| Public API / CLI / script entry | no | 无 HTTP/CLI 变化；TS 导出面归 Legacy 包 |
| Config / project setup | no | 不改 `biome.json`/knip/vitest 配置 |
| File IO / path safety / overwrite | no | 不涉 |
| Schema / columns / units / field names | no | 不涉 DTO 与 `session-contract.ts` |
| Auth / permissions / secrets | no | 401 交给 `isUnauthorized` 早退，逐字搬迁，由 Error handling 包覆盖 |
| Resource limits / large input / discovery | no | 行数上限由 size-guard 覆盖 |
| Release / packaging / dependency compatibility | no | 无依赖变化（`npm run build --workspace web` 作回归命令） |
| Documentation / migration notes | no | 源码结构说明归 9.1 |

## 通用纪律（继承父 tasks.md）
- [ ] 纯搬迁 = `bash scripts/size-guard.sh` 退出 0 + 既有测试**不改动**全绿 + knip 零新增；搬迁清单与允许改动按 design「Must add/change」。
- [ ] 不新增测试。不触碰 `web/test/**`、`index.ts`、`errors.ts`、`types.ts`、`stream.ts`、`web/src/lib/`、server、Makefile、CI、`biome.json`。允许的既有测试编辑：无。
- [ ] 不加 `biome-ignore`，不在依赖数组中写 `.current`，不预加 7.2+ 的成员或占位导出。
- [ ] 以下命令全部退出 0：`npm test --workspace web`、`npm run build --workspace web`、`make lint`、`make typecheck`、`make anti-drift`（knip 零新增、jscpd 不升高、naming/size guard）；`openspec validate chat-turn-actions-split --strict --no-interactive` 通过。
