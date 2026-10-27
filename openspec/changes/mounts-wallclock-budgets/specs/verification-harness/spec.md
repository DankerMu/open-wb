## ADDED Requirements

### Requirement: 墙钟界值留足进程冷启动余量且不丢回归区分度

用例若用真实墙钟做断言（`Date.now()` 差值）或依赖墙钟定成败（vitest 的 timeout），而计时区间里包含真实的进程创建或退出，那么所用界值 SHALL 给满负载下的进程冷启动留足余量，不得贴着被区分的产品期限：
- 同步回调里有 `spawnSync` 的用例 SHALL 设显式 timeout，不依赖默认的 5000 ms。
- 用于区分「被取消的 attempt 不等满就绪窗口」的界值 SHALL 严格低于该窗口。
- 界值原本顺带区分的其它较短产品期限（例如 `stopChild` 的 SIGTERM 宽限），SHALL 在这些用例里注入到界值以上，使这一类回归仍会在界值断言上变红。

实例：#1804 的 `mounts-config.test.ts` 预检用例，以及 `mounts-manager-lifecycle.test.ts` / `mounts-rest-lifecycle.test.ts` 的 `CANCEL_BOUND_MS`。

#### Scenario: 取消界值在负载下稳定且仍能抓回归
- **WHEN** 满负载运行全量测试，断言 `CANCEL_BOUND_MS` 的用例计时区间含 SIGKILL 假 rclone 与真实 spawn 假 `fusermount3`
- **THEN** 用例通过；若取消路径改为等满就绪窗口，或改为对不理 SIGTERM 的 rclone 走 SIGTERM 宽限，界值断言变红
