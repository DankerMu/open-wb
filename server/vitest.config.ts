import { availableParallelism } from "node:os";
import { mergeConfig } from "vitest/config";
import sharedConfig from "../vitest.shared.mjs";

// 官方 omp 门控用例（WORKBUDDY_OMP_TEST=1）每个 worker 并发拉起真实 omp，多核开发机上按缺省 worker 数
// 会压过 10 s 握手期限（#2002）。上限 3 = CI uid-isolation 4 vCPU 下的缺省 worker 数，那里一直绿、不变；
// 缺省公式见 vitest 4.1.11 resolveMaxWorkers（run 模式 max(numCpus - 1, 1)），所以这里永不高于缺省。
// 未设该变量时不叠加任何字段，与共享配置逐字等效。
const ompTestWorkers =
  process.env.WORKBUDDY_OMP_TEST === "1"
    ? { maxWorkers: Math.max(1, Math.min(3, availableParallelism() - 1)) }
    : {};

export default mergeConfig(sharedConfig, { test: { ...ompTestWorkers } });
