# Tasks: welcome-scene-workspace（#533）

## 7. web — 欢迎页场景胶囊与 composer footer 空间选择（父 tasks 7.3）

- [x] 7.3 新建 `scene-pills.tsx`（hero 与快捷任务行之间 `场景` 组：`日常办公`/`代码开发`/`创意设计`，`aria-pressed`，默认日常办公；切换换快捷任务清单并 toast `已切换到「<场景名>」场景`，重复点击无变化）+ `welcome-content.ts` 增三组场景清单（demo:1221-1239；图标只用已注册键）+ `composer-footer.tsx`（仅欢迎态 composer 卡片内工具栏之后：`任务启动于 <空间名>|未选择`（folder）→ Popover：`搜索工作空间` 大小写不敏感过滤、恒有 `未选择`、各空间「名称 + `<account>/<dir>`」按返回顺序、无匹配 `没有匹配的工作空间`、读取中 `正在读取工作空间`、失败文案；不渲染权限元素/新建/挂载）+ `welcome-options.ts`（场景与空间的页面内存状态、body 构造）；欢迎态首次发送与侧栏 `新建会话` 均以 `createSession({scene, workspaceId?}, {signal})` 创建；`workspace-list.ts` 返回值加 `error`；`≤760px` 快捷任务行单行横向滚动。验证：新建 `web/test/chat-page-welcome-scene.test.tsx`（W1–W14）；既有测试除一处断言外零 diff（proposal「偏差」3）；CI `ui-walk` 两个 project 全绿

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | 创建请求 body 是会话绑定空间的唯一前端入口，两条创建路径须一致 → W4、W5、W8、W9、CI ui-walk |
| Schema / columns / units / field names | yes | body 恰为 `{scene}` 或 `{scene, workspaceId}`，键缺席而非 null；场景值与文案一一对应 → W3、W4、W5、W8 |
| Concurrency / shared state / ordering | yes | 选中空间与列表重读/失败/账号切换、composer 锁定时的弹层、状态在欢迎态卸载后保留 → W10、W12、W13 |
| Error handling / rollback / partial outputs | yes | 空间列表读取中/失败仍可选 `未选择`、创建失败后选择保留 → W7、W14 |
| Legacy compatibility / examples | yes | 日常办公清单与既有静态内容、会话页 composer 结构、侧栏分区、首屏约束 → W1、W11、既有套件、CI ui-walk、一次性真实浏览器观察 |
| Auth / permissions / secrets | no | 只读本账号既有列表；权限开关不渲染（W6 钉住） |
| File IO / path safety / overwrite | no | 只显示逻辑路径 `<account>/<dir>`，不渲染根路径（W5 以可辨识的 `root` 钉住） |
| Config / project setup | no | 无 |
| Resource limits / large input / discovery | no | 空间数量由服务端配额约束；弹层内列表可滚动 |
| Release / packaging / dependency compatibility | no | 不加依赖；图标均已注册 |
| Documentation / migration notes | no | spec delta 即文档；ui-walk 步骤归 8.2a |

## 通用纪律（继承父 tasks.md）
- [x] 新测试进新文件；既有测试只改 proposal「偏差」3 列出的一处断言，文件不增行。
- [x] RED 集合 = W1–W14（W11 的「会话页 composer 卡片末元素仍是工具栏」为保持项，实现前后皆绿）。实现前后各跑一次并记录命令与结果。
- [x] `page.tsx`：680 → ≤690，PR 记录两个数。
- [x] `npm test --workspace web`、`make lint`、`make typecheck`、`make anti-drift`（knip 零新增、jscpd 零新增）、`bash scripts/size-guard.sh` 退出 0；`openspec validate welcome-scene-workspace --strict --no-interactive` 通过。
- [x] 一次性真实浏览器观察（1440×900、1024×768 与 390×844）结果写进 PR。
