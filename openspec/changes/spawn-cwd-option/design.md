# Design: spawn-cwd-option（#513）

父设计：design D4（两刀：2.1 可选、2.2 必填；sudo 模式 `--cwd` 位于 `opts.bin` 之后）。行号为 origin/master。

- **Change surface**：`server/src/sessions/omp/process.ts` 的 `SpawnOmpOpts`（:28-38）与 `spawnOmp`（:50-128）；`server/src/sessions/omp/runtime.ts` 的 `SessionRuntimeOpts`（:59-77）、私有字段与构造器（:105-157）、`#openProcess`（:421-435）；`runtime.ts` 末尾 `nonempty`（:784-787）原样移入 `commands.ts`；新测试文件。
- **Must preserve**：
  - 不传 `cwd` 时：argv（含 `--approval-mode write`、`--resume` 规则）、env 白名单、sudo 前缀与 `--preserve-env`、spawn 选项 `{cwd, env, stdio, shell:false}`、四个目录的 `ensureSharedDir` 调用集合与失败语义（非目录占位抛错、不 spawn）全部逐字不变。
  - `spawnOmp(opts, spawnImpl)` 签名、`OmpProcessOpts extends SpawnOmpOpts`、`SessionRuntime` 公开 API 不变。
  - 既有测试零改动全绿：`omp-process.test.ts`、`sudo-launcher.test.ts`、`omp-runtime*.test.ts`、`omp-rpc*.test.ts`、`server/test/support/omp-rpc.ts`，以及所有经 supervisor/pool 的测试（它们不传 `cwd`）。
- **Must add/change**：
  - `SpawnOmpOpts.cwd?: string`（JSDoc：调用方取得的工作目录，缺省所有者根；非所有者根的目录由调用方保证已存在）。
  - `spawnOmp`：`const ownerRoot = join(opts.sandboxRoot, opts.ownerId); const cwd = opts.cwd ?? ownerRoot;` argv `--cwd` 与 `spawnImpl` 的 `cwd` 选项都用这个 `cwd` 变量（同一引用）。目录准备：`if (resolve(cwd) === resolve(ownerRoot)) ensureSharedDir(ownerRoot);`（对规范化的所有者根 mkdir，避免 `<ownerRoot>/proj/..` 这类等值写法逐级建出 `proj`） 然后 session-dir、home、agent 三个 `ensureSharedDir` 照旧（调用顺序：所有者根在前，其余不变）。非所有者根 cwd 既不创建也不检查存在性（存在性检查属 2.2 的调用方）。
  - `SessionRuntimeOpts.cwd?: string`；`readonly #cwd: string | undefined`；`#openProcess` 追加 `...(this.#cwd === undefined ? {} : { cwd: this.#cwd })`（`exactOptionalPropertyTypes` 下不传 `undefined` 键）。
- **Line budget**：`runtime.ts` 797 + 4 = 801，搬迁是必需的：只把 `nonempty`（:784-787）原样移入 `commands.ts` 并导出，`runtime.ts` 的导入列表加 `nonempty`，改后约 798 行；**不搬** `sanitizeError`（它要从 `runtime.js` 值导入 `SessionBusyError`，会引入运行时循环依赖）；不做其它重排；`process.ts` 759 行，改后 ≤ 800。
- **Sibling surfaces**：
  - `server/src/sessions/pool.ts:191` 构造 `SessionRuntime` 不传 `cwd`（2.2 才传）。
  - sudo 模式：`--cwd <值>` 在 `opts.bin` 之后的 omp 参数段，sudoers 行尾 `*` 覆盖（D4）；`uid-isolation` CI 用缺省 cwd，不受影响。
  - `ensureSharedDir`（`server/src/core/sandbox/dirs.ts`）语义不变。
- **Required evidence**（`server/test/omp-spawn-cwd.test.ts`，经 `spawnOmp` 注入录制型 `spawnImpl`（只记录 `command/args/options` 并返回最小假 child，不真正 spawn）、真实临时目录；每条先红后绿，守卫除外）：
  1. 缺省（不传 `cwd`）：argv `--cwd` 值 === 录制的 `options.cwd` === `join(sandboxRoot, ownerId)`；argv 全文与契约逐字相等（含 `--approval-mode write`，无 `--resume`）——守卫（实现前即绿）。
  2. 显式 `cwd`（所有者根下已存在的子目录 `proj`）：argv `--cwd` 与 `options.cwd` 均为该值；argv 其余元素与缺省情形逐字相同（只差 `--cwd` 值），env 逐字相同——实现前红。
  3. 所有者根缺失：缺省与显式 `cwd === ownerRoot`（含带尾斜杠的等值写法 `ownerRoot + "/"`）两种下，spawn 时所有者根、session-dir、home、agent 均已存在。缺省情形是守卫（characterization）；显式 `ownerRoot + "/"` 情形另外断言 argv `--cwd` === `options.cwd` === `ownerRoot + "/"` 的字面值（实现前红）；另加 `<ownerRoot>/proj/..` 写法：所有者根被建出而 `proj` 不存在。
  4. 显式非所有者根 cwd（`<ownerRoot>/missing`）且缺失：spawn 后该路径仍不存在（未 mkdir）；所有者根本身也未被创建（若事先不存在）；session-dir/home/agent 已建出；`spawnImpl` 被调用一次且 `options.cwd` 为该值——实现前红。
  5. sudo 模式：前置用 `useSetprivStub()`（`server/test/support/setpriv.ts:45`，同 `omp-process.test.ts:113`），测试内 `process.env.PATH = "/usr/bin:/bin"` 并在 afterEach 还原；**不设任何跳过条件**。断言 `command === "sudo"`，`opts.bin` 之后的参数段逐字等于显式 cwd 下的 omp argv，`options.cwd` 为同值。
  6. 经 `SessionRuntime` 传入所有者根下已存在的 `proj`（不是所有者根）：录制器包在 FakeChild 外 `(c, a, o) => { calls.push({ c, a, o }); return fake.spawnImpl(c, a, o); }`（`FakeChild.spawnImpl` 忽略 args/options）；拿到第一条录制后 `await runtime.shutdown()`，并给 `prompt(...).dispatched` 挂 rejection handler。录制的 argv `--cwd` 与 `options.cwd` 为 `proj`；不传 `cwd` → 为所有者根（证明 `#openProcess` 接线，前者实现前红）。
  7. 既有 spawn 契约测试零改动全绿；`wc -l runtime.ts process.ts` ≤ 800。
