/**
 * `kb` 模块入口，第十二个启动模块（s2a-kb-ragflow D18；http-service-skeleton「Shared agent module assembly」）。
 * 装配只传 `KbDependencies` 这一个对象，后续各组只扩这个类型。省略即知识库关闭，模块照常注册（ragflow-backend
 * 「知识库可用性」）：关闭时不建客户端，不发任何出站请求。
 *
 * 客户端只建这一个：`kb_upstream_auth_failed` 的限频状态在实例里，「同一进程 60 秒内至多一行」靠它成立。
 * 注册不碰 RAGFlow，构造 store 也不读库。
 */
import type { FastifyInstance } from "fastify";
import type { KbKeyHandle } from "./key-file.js";
import { createRagflowClient, type Deadlines, perMinute } from "./ragflow-client.js";
import { registerKbRoutes } from "./rest.js";
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
}

export function registerKb(app: FastifyInstance, dependencies: KbDependencies | undefined): void {
  if (dependencies === undefined) {
    registerKbRoutes(app, undefined);
    return;
  }
  const { uploadMaxBytes, uploadMaxFiles, ...client } = dependencies;
  const { log, now = Date.now } = dependencies;
  registerKbRoutes(app, {
    store: createKbStore(app.db),
    client: createRagflowClient(client),
    uploadMaxBytes,
    uploadMaxFiles,
    onVersionMismatch: perMinute(now, () => log({ event: "kb_version_mismatch" })),
  });
}
