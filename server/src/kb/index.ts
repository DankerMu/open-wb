/**
 * `kb` 模块入口，第十二个启动模块（s2a-kb-ragflow D18；http-service-skeleton「Shared agent module assembly」）。
 * 装配只传 `KbDependencies` 这一个对象，后续各组只扩这个类型。省略即知识库关闭，模块照常注册（ragflow-backend
 * 「知识库可用性」）：关闭时不建客户端，不发任何出站请求。
 *
 * 客户端只建这一个：`kb_upstream_auth_failed` 的限频状态在实例里，「同一进程 60 秒内至多一行」靠它成立。两种锁也只建
 * 这一份（D20）：设置锁是进程级的。注册不碰 RAGFlow，构造 store 也不读库。工作空间的 store、沙箱 facade 与挂载 manager 取
 * `app` 上已有的那一份：`kb` 注册晚于 `workspaces`，不另建。
 *
 * 开启时注册返回 `models` 的写入钩子（D1）：`kb` 注册晚于 `models`，由 `app.ts` 绑过去；`models` 不导入 `kb`。
 */
import type { FastifyInstance } from "fastify";
import { emit } from "../core/audit/index.js";
import type { ModelWriteGuard } from "../models/rest.js";
import { createModelStore } from "../models/store.js";
import { createKbBases } from "./bases.js";
import {
  createKbDocuments,
  type DocumentRemovalTiming,
  type KbDocumentRecord,
} from "./documents.js";
import type { EmbeddingProbeDeadlines } from "./embedding-probe.js";
import type { KbKeyHandle } from "./key-file.js";
import { createKbLocks } from "./locks.js";
import { createKbPipeline, type KbPipelineRecord } from "./pipeline.js";
import { createRagflowClient, type Deadlines, perMinute } from "./ragflow-client.js";
import { registerKbRoutes } from "./rest.js";
import { createKbSettings } from "./settings.js";
import { createSourceFiles } from "./source-file.js";
import { createKbStore } from "./store.js";
import { createKbUploads, type UploadBodyDeadline } from "./uploads.js";

/** 这个模块写到受管 stderr writer 的记录。 */
export type KbRecord =
  | { event: "kb_upstream_auth_failed" | "kb_version_mismatch" }
  | KbPipelineRecord
  | KbDocumentRecord;

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
  log: (record: KbRecord) => void;
  /** 两条限频记录的时钟（测试注入）；省略时 `Date.now`。 */
  now?: () => number;
  /** 客户端的期限（测试注入短期限）；省略的项取缺省。 */
  deadlines?: Partial<Deadlines>;
  /** 嵌入探活的期限（测试注入短期限）；省略时取 `embedding-probe.ts` 的缺省。 */
  probeDeadlines?: EmbeddingProbeDeadlines;
  /** 两种锁（测试注入，读等待者计数）；省略时在这里建，生产装配不传。 */
  locks?: ReturnType<typeof createKbLocks>;
  /** RAGFlow 文档删除的重发节奏（测试注入短期限）；省略时每 500 ms、至多 5 s（D13）。 */
  documentDelete?: DocumentRemovalTiming;
  /** 本地上传读请求体的总期限（测试注入短期限）；省略时每秒 64 KiB、不少于 60 s（D11）。 */
  uploadBodyDeadline?: UploadBodyDeadline;
  /** 测试缝：源文件 `fstat` 之后、读取之前调用；生产不传。 */
  onSourceStat?: (absPath: string) => void;
}

export function registerKb(
  app: FastifyInstance,
  dependencies: KbDependencies | undefined,
): ModelWriteGuard | undefined {
  if (dependencies === undefined) {
    registerKbRoutes(app, undefined);
    return undefined;
  }
  const {
    uploadMaxBytes,
    uploadMaxFiles,
    probeDeadlines,
    locks = createKbLocks(),
    documentDelete,
    uploadBodyDeadline,
    onSourceStat,
    ...clientOptions
  } = dependencies;
  const { log, now = Date.now } = dependencies;
  const store = createKbStore(app.db);
  const client = createRagflowClient(clientOptions);
  const audit = (event: Parameters<typeof emit>[1]): void => {
    emit(app.db, event);
  };
  const settings = createKbSettings({
    store,
    client,
    models: createModelStore(app.db),
    locks,
    audit,
    probeDeadlines,
  });
  registerKbRoutes(app, {
    store,
    client,
    uploadMaxBytes,
    uploadMaxFiles,
    onVersionMismatch: perMinute(now, () => log({ event: "kb_version_mismatch" })),
    settings,
    bases: createKbBases({
      store,
      client,
      pipeline: createKbPipeline({ client, log }),
      locks,
      audit,
    }),
    documents: createKbDocuments({
      store,
      client,
      locks,
      audit,
      log,
      sources: createSourceFiles({
        workspaces: app.workspaces,
        mounts: app.mounts,
        onStat: onSourceStat,
      }),
      uploadMaxBytes,
      uploadMaxFiles,
      removalTiming: documentDelete,
    }),
    uploads: createKbUploads({
      store,
      client,
      locks,
      audit,
      log,
      uploadMaxBytes,
      removalTiming: documentDelete,
      bodyDeadline: uploadBodyDeadline,
    }),
  });
  return settings.guardModelWrite;
}
