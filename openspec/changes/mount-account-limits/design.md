## Design

Change surface：
- 配置：`mounts/config.ts` 的 `resolveMountSettings` 和 `MountSettings` 增加 `mountMaxPerAccount`、`mountMaxAttachingPerAccount`。`startup-registry.ts` 的 `workspaceAssemblyOf` 把两者带进 `mountSettings`。`app.ts` 像 `mountMaxOf` 那样取值，传给挂载路由；缺席时取缺省值。
- 计数：`mounts/store.ts` 增加 `countByOwner(ownerId)`，SQL 为 `SELECT COUNT(*) FROM workspace_mounts WHERE owner_id = ?`。挂载行插入时 `owner_id` 就是建出者，空间只属于它的 owner。
- 判定：放在 `mounts/rest-mounts.ts` 的 POST 处理里。临时空间判定之后、`manager.attach` 之前，有一个同步段，中间没有 `await`，依次做：
  1. `attaching(owner) >= mountMaxAttachingPerAccount` → 409；
  2. `countByOwner(owner) + attaching(owner) >= mountMaxPerAccount` → 409；
  3. `attaching(owner) += 1`。
  
  然后 `try { await manager.attach(...) } finally { attaching(owner) -= 1 }`；计数归零时删掉该键。`attaching` 是 `registerMounts` 闭包里的一个 `Map<ownerId, number>`，每个 app 一个，与 manager 同寿命。
- 文案：`core/errors/index.ts` 中 `mount_limit` 的文案改为 `挂载数已达上限`。

Must preserve：
- `MOUNT_MAX_PER_WORKSPACE` 的判定不变，仍在空间串行链的 `before` 里，所以同一空间并发建出时恰有一个 201。
- 判定次序中已有的各步不变：未认证、空间归属、功能关闭、body、临时空间都排在新判定之前；新判定排在空间上限、源、同名、主机规则之前。
- 被拒的建出不写 `mount.reject`，也不启动子进程（与空间上限一致）。
- `DELETE`、`GET`、挂载源端点、启动恢复 `restoreAll`、重挂退避都不计入在途，也不受这两个上限约束。它们不是由请求触发的建出，总数已经被挂载行数约束住。
- 码 `mount_limit` 和状态码 409 不变，web 不按文案分支。

Must add/change：
- `MountSettings` 的 `mountMaxPerAccount`、`mountMaxAttachingPerAccount` 设为必填，与 `mountMaxPerWorkspace` 同级，`resolveMountSettings` 总会给出这两个字段。
- 受影响的精确字面量要同步更新：
  - `server/test/mounts-config.test.ts:2`（头注释「三个挂载键」）、`:148`（「三键全缺」）、`:181`、`:434`；
  - `server/test/mounts-manager-assembly.test.ts:48,216`；
  - `server/test/mounts-rest-hosts.test.ts:169,248`；
  - `server/test/mounts-rest.test.ts:300`；
  - `server/test/mounts-rest-helpers.ts` 的 `OpenOptions.mountSettings`。
- 其余见 Change surface；还有 system.md 的「三个配置键」一段改为五个，「挂载端点」的判定次序同步更新。

Governing invariant：
- 任一时刻，一个账号的挂载行数加上它在途的建出数不超过 `MOUNT_MAX_PER_ACCOUNT`，在途建出数不超过 `MOUNT_MAX_ATTACHING_PER_ACCOUNT`。
- 每次被受理的建出，无论以何种方式落定（201、任何 4xx/5xx、关停取消），在途计数都恰好减一。客户端断开不算落定，计数要等 attach 自己结束时才释放。

Sibling surfaces：
- 取消：
  - 关停时 `closeAll` 让在途的 `attach` reject，`finally` 减一。
  - 请求中止不取消建出：路由不处理 abort。客户端断开后，`manager.attach` 照常跑完，以 201 或 502 结束，计数在那时才释放。通常不超过一个 20 s 就绪窗口；主机解析（`dns.lookup` 没有超时）或 `local` 源的 `realpath` 卡住时，要等它们返回（PR #1807 invariant-state Note）。
- `within` 里抛出（插行或审计失败、源被标删除）：attach 会 reject，同样走 `finally`。
- 主机解析的 2 个全局名额（`attempt.ts` 的 `HOST_LOOKUPS_IN_FLIGHT`）不改。一个账号的 2 个在途建出，或它离线挂载的重挂解析，就能占满这 2 个名额，让其它账号的主机名解析排队延后（先进先出，不会被永久饿死）。这是早于本变更的已知残余；owner 选了按账号计，没有选全局（PR #1807 invariant-state Note）。
- 进程总数上界：账号是迁移种子建出的，没有注册端点，账号数固定。常驻进程不超过 账号数 × 32，在途不超过 账号数 × 2。

Seams under test：
- `resolveMountSettings`（纯函数）；
- `createApp` 加假 rclone 的 REST 层（沿用 `mounts-rest-helpers` 的 world），其中就绪挂起、就绪失败都由假 rclone 设定；
- 编译入口的启动用例（http-service-skeleton「挂载键与启动预检」，非法值各一例）。

Required evidence：
- 配置：五键缺省值依次为未配置、不限、8、32、2；以 `MOUNT_MAX_PER_ACCOUNT=5`、`MOUNT_MAX_ATTACHING_PER_ACCOUNT=1` 解析得 5、1；两个新键分别取 empty、`0`、`08`、`2147483648` 都是配置错误，message 含键名、不含取值。
- 在途：`MOUNT_MAX_ATTACHING_PER_ACCOUNT=1` 时：
  - zhangsan 在空间 A 的建出就绪挂起，这时他在空间 B 的建出返回 409，没有 spawn，也没有 `mount.reject`；
  - lisi 同时建出返回 201；
  - A 以 502 落定后，B 再建出返回 201。
  
  另外两例证明落定后计数会释放：A 被 `before` 拒绝（同名，409 `conflict`）、A 以 201 成功。两例之后 B 都能建出。
  关停一例：A 就绪挂起时，测试直接调用 `app.mounts.closeAll()`，随后 B 发 POST。B 应得 503 `mount_disabled`，而不是 409 `mount_limit`。依据是 `manager.enabled` 是静态的，preParsing 放行；新判定排在 `manager.attach` 之前，计数要是漏减，B 会先撞上 409。
- 总数：`MOUNT_MAX_PER_ACCOUNT=2` 时：
  - A、B 各建一个之后，C 返回 409；
  - lisi 不受影响；
  - 卸载一个之后，C 返回 201。
  
  `MOUNT_MAX_PER_ACCOUNT=1`、`MOUNT_MAX_ATTACHING_PER_ACCOUNT=2` 时，两个空间同时建出：恰一个 201、一个 409，恰一个假 rclone 在运行。
- 文案：七个挂载码的信封用例里，`mount_limit` 的文案为 `挂载数已达上限`。
- 先在改前的代码上跑一次新增用例，确认为红。

Non-goals：
- 不加全局在途上限，也不加全站挂载总数上限。
- 不改主机解析的名额。
- 不限制正式空间的数量。
- 不追溯：升级前已超过 32 个的账号，其已有挂载照常恢复，之后只是建不出新的。

Review focus：
- 在途计数在每条落定路径上恰好减一，没有泄漏，也不会减到负数；
- 判定与加一之间确实没有 `await`；
- 账号总数把在途计入后，并发时不会超额。两个建出不可能都因为计入了对方而被拒：后进入同步段的那个，一定能看到前一个的加一。但卡在边界上的建出，会被在途的那一个挡下。例如已有 31 个挂载，A 在途且最终 502，B 就会 409。等 A 落定后重试即可。这一点和空间上限不同，空间上限在串行链上排队判定；
- 瞬时窗口：从 `store.create` 插行到路由层 `finally` 减一之间隔着几次 microtask，这段时间里同一个挂载会同时算进行数和在途数。正好落在窗口里的请求会多拿一次 409。方向偏保守，而且是瞬时的；
- 判定次序与 spec 一致；
- 四十二项配置计数、文案在各处同步。
