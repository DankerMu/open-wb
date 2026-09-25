## ADDED Requirements

### Requirement: 创建浮层的焦点时序与模态清理
经切换器或 `新建` 菜单打开的 `新建工作空间`、`新建文件夹` 对话框 SHALL 均为 `aria-modal="true"`，其初始焦点（`工作空间名称` / `位置`）SHALL 在菜单或弹层关闭后延迟一个宏任务的回焦执行之后仍然成立。任一取消类关闭（`取消`、`关闭`、Escape、点遮罩）之后，`document.body` SHALL 不残留 `pointer-events` 内联样式，应用根 SHALL 不残留 `aria-hidden`。创建请求挂起期间点遮罩 SHALL 与 `取消` 等价：关闭对话框、中止该请求、焦点回到触发器，且不再发出新请求。

#### Scenario: 初始焦点经受延迟回焦
- **WHEN** 经菜单或切换器打开 `新建工作空间`，或经菜单选择 `新建文件夹`，并等待一个宏任务
- **THEN** 对话框为 `aria-modal="true"`，`document.activeElement` 仍为 `工作空间名称` / `位置`

#### Scenario: 取消类关闭无模态残留
- **WHEN** 经菜单路径与切换器路径各做一次取消类关闭且焦点已回到触发器
- **THEN** `document.body.style.pointerEvents` 为空串，渲染容器无 `aria-hidden` 属性

#### Scenario: 挂起期点遮罩中止请求
- **WHEN** `新建文件夹` 提交后 `POST …/dirs` 挂起，等待一个宏任务后按压遮罩
- **THEN** 对话框关闭，该请求 signal 已中止，焦点回到 `新建`，全程恰 1 次 POST
