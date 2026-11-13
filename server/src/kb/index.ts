/**
 * `kb` 模块入口，第十二个启动模块（s2a-kb-ragflow D18；http-service-skeleton「Shared agent module assembly」）。
 * 装配只传 `KbDependencies` 这一个对象，后续各组只扩这个类型。省略即知识库关闭，模块照常注册（ragflow-backend
 * 「知识库可用性」）：关闭时不建客户端，不发任何出站请求。
 *
 * 客户端只建这一个：`kb_upstream_auth_failed` 的限频状态在实例里，「同一进程 60 秒内至多一行」靠它成立。两种锁也只建
 * 这一份（D20）：设置锁是进程级的。注册不碰 RAGFlow，构造 store 也不读库。工作空间的 store、沙箱 facade 与挂载 manager 取
 * `app` 上已有的那一份：`kb` 注册晚于 `workspaces`，不另建。
 *
 * 开启时注册返回 `models` 的写入钩子（D1）与会话检索（s2c-kb-session D5，`kb/session-search.ts`）：`kb` 注册晚于 `models`，
 * 由 `app.ts` 绑过去；`models` 与 `sessions` 都不导入 `kb`。关闭时返回 `null`，两者都没有。重排降级的限频记录只建一份，
 * 检索测试端点与会话检索共用（ragflow-backend「同一进程 60 秒内至多一行」）。
 *
 * 重建器（`kb/rebuild.ts`，#1852）也只建这一个，挂在 `app.kbRebuild` 上：入口在 `server_started` 之后调 `start` 续做，关停时在
 * 关闭 DB 之前调 `stop`（`startup-registry.ts`）。知识库关闭时它是空操作：不启动，`rebuilding` 的库保持原状。
 */
import type { FastifyInstance } from "fastify";
import { emit } from "../core/audit/index.js";
import type { ModelWriteGuard } from "../models/rest.js";
import { createModelStore } from "../models/store.js";
import { createKbBases } from "./bases.js";
import { createCompileStatus } from "./compile-status.js";
import {
  createKbDocuments,
  type DocumentRemovalTiming,
  type KbDocumentRecord,
} from "./documents.js";
import type { KbKeyHandle } from "./key-file.js";
import { createKbLocks } from "./locks.js";
import type { ModelProbeDeadlines } from "./model-probe.js";
import { createKbPipeline, type KbPipelineRecord } from "./pipeline.js";
import { createRagflowClient, type Deadlines, perMinute } from "./ragflow-client.js";
import { createKbRebuilder, type KbRebuilder } from "./rebuild.js";
import { registerKbRoutes } from "./rest.js";
import { createKbRetrieval } from "./retrieval.js";
import { createKbSessionSearch } from "./session-search.js";
import { createKbSettings } from "./settings.js";
import { createSourceFiles } from "./source-file.js";
import { createKbStore } from "./store.js";
import { createKbUploads, type UploadBodyDeadline } from "./uploads.js";

declare module "fastify" {
  interface FastifyInstance {
    /** 这个 app 的重建器：知识库关闭时是空操作。 */
    kbRebuild: KbRebuilder;
  }
}

/** 知识库关闭时没有重建器（D8）。 */
const NO_REBUILD: KbRebuilder = { start: () => undefined, stop: () => Promise.resolve() };

/** 这个模块写到受管 stderr writer 的记录。 */
export type KbRecord =
  | { event: "kb_upstream_auth_failed" | "kb_version_mismatch" | "kb_rerank_degraded" }
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
  /** 三条限频记录的时钟（测试注入）；省略时 `Date.now`。 */
  now?: () => number;
  /** 客户端的期限（测试注入短期限）；省略的项取缺省。 */
  deadlines?: Partial<Deadlines>;
  /** 知识库模型探活的期限（测试注入短期限）；省略时取 `model-probe.ts` 的缺省。 */
  probeDeadlines?: ModelProbeDeadlines;
  /** 两种锁（测试注入，读等待者计数）；省略时在这里建，生产装配不传。 */
  locks?: ReturnType<typeof createKbLocks>;
  /** RAGFlow 文档删除的重发节奏（测试注入短期限）；省略时每 500 ms、至多 5 s（D13）。 */
  documentDelete?: DocumentRemovalTiming;
  /** 本地上传读请求体的总期限（测试注入短期限）；省略时每秒 64 KiB、不少于 60 s（D11）。 */
  uploadBodyDeadline?: UploadBodyDeadline;
  /** 测试缝：源文件 `fstat` 之后、读取之前调用；生产不传。 */
  onSourceStat?: (absPath: string) => void;
  /** 列表里编译状态读取的总期限（测试注入短期限）；省略时 5 s（D9）。 */
  compileStatusDeadlineMs?: number;
  /** 测试缝：重建器的一轮排到哪里跑，用例同步驱动；生产不传，下一轮事件循环。 */
  rebuildSchedule?: (pass: () => Promise<void>) => void;
}

/** 开启时交回给 `app.ts` 的句柄。 */
interface KbRegistration {
  modelWriteGuard: ModelWriteGuard;
  sessionSearch: ReturnType<typeof createKbSessionSearch>;
}

export function registerKb(
  app: FastifyInstance,
  dependencies: KbDependencies | undefined,
): KbRegistration | null {
  if (dependencies === undefined) {
    app.decorate("kbRebuild", NO_REBUILD);
    registerKbRoutes(app, undefined);
    return null;
  }
  const {
    uploadMaxBytes,
    uploadMaxFiles,
    probeDeadlines,
    locks = createKbLocks(),
    documentDelete,
    uploadBodyDeadline,
    onSourceStat,
    compileStatusDeadlineMs,
    rebuildSchedule,
    ...clientOptions
  } = dependencies;
  const { log, now = Date.now } = dependencies;
  const store = createKbStore(app.db);
  const client = createRagflowClient(clientOptions);
  const onRerankDegraded = perMinute(now, () => log({ event: "kb_rerank_degraded" }));
  const audit = (event: Parameters<typeof emit>[1]): void => {
    emit(app.db, event);
  };
  const pipeline = createKbPipeline({ client, log });
  const rebuild = createKbRebuilder({
    store,
    client,
    pipeline,
    locks,
    audit,
    schedule: rebuildSchedule,
  });
  app.decorate("kbRebuild", rebuild);
  const settings = createKbSettings({
    store,
    client,
    models: createModelStore(app.db),
    locks,
    audit,
    probeDeadlines,
    onRebuild: rebuild.wake,
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
      pipeline,
      locks,
      compileStatus: createCompileStatus({ store, client, deadlineMs: compileStatusDeadlineMs }),
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
    retrieval: createKbRetrieval({
      store,
      client,
      locks,
      audit,
      onRerankDegraded,
    }),
  });
  return {
    modelWriteGuard: settings.guardModelWrite,
    sessionSearch: createKbSessionSearch({ store, client, onRerankDegraded }),
  };
}
