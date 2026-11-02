/**
 * `kb` 模块入口，第十二个启动模块（s2a-kb-ragflow D18；http-service-skeleton「Shared agent module assembly」）。
 * 装配只传 `KbDependencies` 这一个对象，后续各组只扩这个类型。省略即知识库关闭，模块照常注册（ragflow-backend
 * 「知识库可用性」）：关闭时不建客户端，不发任何出站请求。
 *
 * 客户端只建这一个：`kb_upstream_auth_failed` 的限频状态在实例里，「同一进程 60 秒内至多一行」靠它成立。两种锁也只建
 * 这一份（D20）：设置锁是进程级的。注册不碰 RAGFlow，构造 store 也不读库。
 */
import type { FastifyInstance } from "fastify";
import { emit } from "../core/audit/index.js";
import { createModelStore } from "../models/store.js";
import type { EmbeddingProbeDeadlines } from "./embedding-probe.js";
import type { KbKeyHandle } from "./key-file.js";
import { createKbLocks } from "./locks.js";
import { createRagflowClient, type Deadlines, perMinute } from "./ragflow-client.js";
import { registerKbRoutes } from "./rest.js";
import { createKbSettings } from "./settings.js";
import { createKbStore } from "./store.js";

export interface KbDependencies {
  /** `kb_key` 阶段读出的只读句柄。 */
  key: KbKeyHandle;
  /** RAGFLOW_BASE_URL。 */
  baseUrl: string;
  /** KB_UPLOAD_MAX_BYTES。 */
  uploadMaxBytes: number;
  /** KB_UPLOAD_MAX_FILES。 */
  uploadMaxFiles: number;
  /** 受管 stderr writer。 */
  log: (record: { event: "kb_upstream_auth_failed" | "kb_version_mismatch" }) => void;
  /** 两条限频记录的时钟（测试注入）；省略时 `Date.now`。 */
  now?: () => number;
  /** 客户端的期限（测试注入短期限）；省略的项取缺省。 */
  deadlines?: Partial<Deadlines>;
  /** 嵌入探活的期限（测试注入短期限）；省略时取 `embedding-probe.ts` 的缺省。 */
  probeDeadlines?: EmbeddingProbeDeadlines;
}

export function registerKb(app: FastifyInstance, dependencies: KbDependencies | undefined): void {
  if (dependencies === undefined) {
    registerKbRoutes(app, undefined);
    return;
  }
  const { uploadMaxBytes, uploadMaxFiles, probeDeadlines, ...clientOptions } = dependencies;
  const { log, now = Date.now } = dependencies;
  const store = createKbStore(app.db);
  const client = createRagflowClient(clientOptions);
  const locks = createKbLocks();
  registerKbRoutes(app, {
    store,
    client,
    uploadMaxBytes,
    uploadMaxFiles,
    onVersionMismatch: perMinute(now, () => log({ event: "kb_version_mismatch" })),
    settings: createKbSettings({
      store,
      client,
      models: createModelStore(app.db),
      locks,
      audit: (event) => emit(app.db, event),
      probeDeadlines,
    }),
  });
}
