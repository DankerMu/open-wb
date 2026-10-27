## Design

Change surface：`server/src/workspaces/mounts/attempt.ts` 的 `createAttempts`。

- 现在：`limitedResolve(host) = lookupLimit(() => resolveHost(host))`。
- 改为：`limitedResolve(ownerId, host) = accountLimitOf(ownerId)(() => lookupLimit(() => resolveHost(host)))`。
  - `accountLimitOf` 维护 `Map<ownerId, limiter(1)>`，每个账号一个容量为 1 的限流器。某账号已无在途、也无等待时删掉它的键。实现上可以给 `limitConcurrency` 加一个「空闲」回调，也可以在包装层计数后删除。
  - `target(remote)` 改为 `target(remote, ownerId)`，`judgeHost` 收到的是绑定了该账号的 resolver。
- `manager.ts` 的两个调用点：`remountOnce` 传 `record.ownerId`，`attachNow` 传 `input.ownerId`。`local` 源不走解析。

Must preserve：
- 全局最多 2 个在途解析。
- 一个任务完成时，名额直接交给下一个等待者，与现有 `limitConcurrency` 的语义一致。
- IP 字面量不经过 resolver（`judgeHost` 现有行为）。
- abort（卸载或关停）时，attempt 不再等待未完成的判定（`untilAborted`）。但已经进入 resolver 的 lookup 仍占着名额，直到它自己返回，因为 `dns.lookup` 不能取消，线程也确实被占着。这一点与现在相同。
- 解析失败时为 `mount_failed` 或保持 `offline`，不 spawn。
- 主机规则的判定和地址写入 `rclone.conf` 的逻辑都不变。

Governing invariant：任一时刻，进入系统解析器的调用不超过 2 个；同一账号进入的不超过 1 个。每个进入过账号限流或全局限流的任务，在它落定时（成功、失败、抛错都算）都恰好释放一次。

Sibling surfaces：
- 两个调用点（建出、重挂）都在 `manager.ts` 中。启动恢复 `restoreAll` 走 `remountOnce`。
- 探测（`probe.ts`）只做 IP 加端口的 TCP 连接，不解析，不受影响。
- 预览、会话等其它模块不经过这个 resolver。
- 线程池的其它占用者见 system.md 第 973–974 行，不在本次范围内。

Seams under test：manager 层用 `hangingResolver()` 注入的 resolver（`server/test/mounts-manager.test.ts`），按账号控制每次调用何时挂起、何时返回。

Required evidence。确定性的做法：
- 正向条件，即「某次调用已进入 resolver」，用轮询 `pending.length === K` 来等。
- 否定条件，即「没有别的调用进来」，先等正向条件成立，再 `await new Promise(setImmediate)` 让出一个宏任务，然后断言 `pending` 没变。这样做能成立，是因为建出从 `attach()` 到限流器之间只经过微任务、没有 I/O（manager.ts:648-668 → attempt.ts:183-187 → host-policy.ts:36-54）。
- 重挂路径先走 `lazyUnmount`，中间有 I/O，所以重挂调用进入 resolver 只能用正向轮询来等。
- 到达次序靠逐个提交来固定：提交下一个之前，先确认上一个已进入 resolver，或已按上面的否定判据处于等待状态。

用例如下。
- 同账号串行：zhangsan 在空间 W1、W2 各建一个主机名挂载，resolver 挂起。只有 1 次调用进入；第一次失败返回后，第二次才进入。
- 跨账号并行，全局上限 2：zhangsan、lisi、第三个账号各建一个挂载。前两个账号各进入 1 次，第三个账号等待。任一账号的调用返回后，第三个账号的调用进入。全程 resolver 的在途调用数不超过 2。
- 账号的等待者不占全局名额：按 Z1 → Z2 → lisi 的固定次序提交，在途应为 Z1 和 lisi，Z2 在 zhangsan 自己的队列里等。如果 lisi 先到，反过来嵌套也会得到同样结果，用例会误绿，所以次序必须固定。
- 键不会被提前删除：Z1 失败后，Z2 经交接成为 zhangsan 的在途解析；这时 zhangsan 在 W3 提交 Z3，Z3 必须等待。
- Map 的生命周期：限流器只在 `createAttempts` 内部，manager 层观测不到键有没有泄漏，这一项只靠代码评审保证。
- 重挂计入所属账号：zhangsan 在 W1 的一个离线挂载重挂时 resolver 挂起，这时 zhangsan 在**另一个空间 W2** 新建出的挂载等待，lisi 新建出的挂载立即进入 resolver。新建必须放在别的空间：重挂占着 W1 的串行链，同空间的建出会卡在链上，根本到不了限流器，那样用例就误绿了。
- 名额会释放：
  - resolver 失败返回、成功返回，之后同账号的下一次解析都能进入；
  - abort 之后仍占着账号名额，直到 lookup 返回：zhangsan 在 W1 有一个离线挂载正在重挂，它的解析挂起，这时 detach 这个挂载（`cancel` → `entry.attempt?.abort()`），并 `await` 等 detach 落定。之后 zhangsan 在**另一个空间 W2** 新建出的挂载继续等待，直到那次挂起的 lookup 被 fail 掉才进入 resolver。用关停 `closeAll` 做不了这个用例：关停之后 attach 都是 `mount_disabled`，新建一个 manager 又会得到新的限流器。
- IP 字面量：两个账号的解析都挂起时，任一账号以 IP 字面量建出都不等待（既有用例按新语义调整）。
- 既有用例「at most two host lookups are in flight across workspaces」改成按账号的版本，断言不能削弱。
- 改前在旧代码上跑新用例，同账号串行这一例应为红（两次调用都会进入 resolver）。

Non-goals：
- 不加配置键。
- 不改用 c-ares。
- 不做 lookup 超时：`dns.lookup` 没法取消，加了超时也只是放弃等待，线程照样被占。
- 不处理线程池的其它占用者。

Residual：两个账号同时用不应答的主机名，仍能占满 2 个全局名额（owner 接受）。有挂起解析的那个账号，自己后续的解析会一直排队，直到系统解析器超时，只影响它自己。

Review focus：
- 两级限流的嵌套顺序：先过账号级，再过全局级，否则账号的等待者会占用全局名额。
- 每条路径恰好释放一次，Map 里的键会被清理，不会无界增长。
- 两个调用点的 `ownerId` 取对。
- 测试是确定性的。
