/**
 * 重建器（s2a-kb-ragflow D8、D20；ragflow-backend「嵌入模型更换与全量重建」，knowledge-bases「同一知识库的写操作串行」）：确认换
 * 嵌入模型或重试之后，把处于 `rebuilding` 的库逐个换到新一代数据集。进程内一次一个库，处理期间持有该库的写锁（`locks.rebuild`）：
 * 锁正被它持有时写操作立即 409；它自己排在在途写操作之后，等到锁才枚举文档，所以排在前面的上传进入新数据集（R2-01）。
 *
 * 取锁之后先重读库行：已删除或不再是 `rebuilding` 即跳过，什么都不建。每个库：
 * 1. `rebuild_dataset_id` 非空时按删除次序删掉残留的一代（不存在视为已删），再置空三个 `rebuild_*` 列。
 * 2. 以原模板与开关、新嵌入模型建新一代，名为 `resourceName(id, 当前代数)`（`owb-<id 前 16 位>-g<代数>`，`pipeline.ts`），
 *    写回三个 `rebuild_*` 列。普通库走 `parse_type:1`，不读账号缺省；开了开关的库经 `createPipeline`，账号缺省缺失即失败，
 *    不发后续请求（`bases.ts` 的 `createGeneration`）。
 * 3. 逐份文档：从旧数据集下载入库原件，原样拼进 multipart 上传到新数据集，再触发这一份的解析。multipart 长度按本地 `size` 算；
 *    字节在流上数（`multipart.ts`）：多出一个字节当场销毁请求体，请求体关闭即销毁下载流，不等读完；少了不发结束边界。下载为
 *    not-found 的文档记为跳过；字节不符、上传或解析触发失败（含 `parse_not_started`）即该库失败。
 * 4. 单事务切换（`store.switchGeneration`），同事务审计 `kb.rebuild {id, result:"ok", skipped}`。
 * 5. 按删除次序删旧一代；删不掉只写一行 leak（`pipeline.discard`），不影响状态。
 * 任一步失败：`rebuild_failed`，同事务审计 `kb.rebuild {id, result:"failed"}`，`rebuild_*` 留着给重试的第 1 步。审计 actor 一律
 * 是 `kb_settings.rebuild_actor_id`。RAGFlow 的 message 与正文不进状态、审计与日志：客户端的结果只有 `kind`。
 *
 * 唤醒（`wake`）只排一轮（`drain`），一轮里按 `created_at`、`id` 逐个处理清单上的库；正在跑时再唤醒，这一轮结束后再走一遍。
 * 排进哪里由 `schedule` 定：生产在下一轮事件循环跑，用例经注入的调度缝同步驱动。`start` 是启动时的续做：对仍是 `rebuilding`
 * 的库从第 1 步做起。一轮永不 reject：续做的失败只改变知识库状态。
 *
 * 关停（`stop`）：中止在途请求（每个出站请求都带同一个 `signal`），只等正在持锁处理的那一个库，不等排队中的 `locks.rebuild`：
 * 写锁的队列不能取消，在途的本地上传最长约 27 分钟（D11），等它就拖住了监听器关停。排队的那一个以后拿到锁，第一件事是看到
 * 已中止，什么都不读就放锁，所以 DB 关闭之后它也不碰库。中止的那一步与不可达同为 `kb_unavailable`，但中止之后不写失败：第 4 步
 * 提交之前该库保持 `rebuilding`，下次启动续做；提交之后已是 `ready`，第 5 步没删完的旧一代成为孤儿，不续删。
 */
import { createGeneration } from "./bases.js";
import type { createKbLocks } from "./locks.js";
import { multipartUpload } from "./multipart.js";
import { type createKbPipeline, type PipelineResources, resourceName } from "./pipeline.js";
import type { createRagflowClient } from "./ragflow-client.js";
import { embeddingModelOf } from "./settings.js";
import type { createKbStore, KbDocument, KnowledgeBase } from "./store.js";
import { templateOf } from "./templates.js";

const FAILED_MESSAGE = "重建失败，可在模型设置里重试";
const SKIPPED = { skipped: true } as const;

interface AuditEvent {
  kind: "kb.rebuild";
  actorId: string;
  title: string;
  detail: object;
}

interface KbRebuilderDependencies {
  store: Pick<
    ReturnType<typeof createKbStore>,
    | "settings"
    | "getBase"
    | "listBasesInState"
    | "listDocuments"
    | "setRebuildGeneration"
    | "failRebuild"
    | "switchGeneration"
  >;
  client: Pick<
    ReturnType<typeof createRagflowClient>,
    "createDataset" | "downloadDocument" | "uploadDocument" | "parseDocument"
  >;
  pipeline: Pick<
    ReturnType<typeof createKbPipeline>,
    "createPipeline" | "deletePipeline" | "discard"
  >;
  locks: Pick<ReturnType<typeof createKbLocks>, "rebuild">;
  /** `core/audit` 的 `emit`，已绑定 DB。 */
  audit: (event: AuditEvent) => void;
  /** 一轮排到哪里跑（测试注入的调度缝）；省略时下一轮事件循环。 */
  schedule?: ((pass: () => Promise<void>) => void) | undefined;
}

type Moved = { ragflowDocumentId: string } | typeof SKIPPED | null;

const nextScheduled = (pass: () => Promise<void>): void => {
  setImmediate(() => {
    void pass();
  });
};

const generationOf = (datasetId: string, canvasId: string | null, groupId: string | null) => ({
  datasetId,
  canvasId,
  templateGroupId: groupId,
});

export function createKbRebuilder(dependencies: KbRebuilderDependencies) {
  const { store, client, pipeline, locks, audit, schedule = nextScheduled } = dependencies;
  const controller = new AbortController();
  const { signal } = controller;
  /** 一轮已排进或正在跑。 */
  let draining = false;
  let again = false;
  /** 正在持锁处理的那一个库；关停只等它。 */
  let current: Promise<void> = Promise.resolve();

  /** 重建器写的审计：actor 是持久化的发起者，续做时也是原发起人。 */
  function record(title: string, detail: object): void {
    const actorId = store.settings().rebuildActorId;
    if (actorId === null) {
      throw new Error("knowledge base rebuild has no recorded actor");
    }
    audit({ kind: "kb.rebuild", actorId, title, detail });
  }

  /** 中止之后不写失败：该库保持 `rebuilding`，下次启动续做。 */
  function fail(id: string): void {
    if (!signal.aborted) {
      store.failRebuild(id, FAILED_MESSAGE, () => {
        record("知识库重建失败", { id, result: "failed" });
      });
    }
  }

  /** 第 1 步：删掉残留的一代再置空三列；删不掉即失败。 */
  async function clearResidual(base: KnowledgeBase): Promise<boolean> {
    const { rebuildDatasetId, rebuildCanvasId, rebuildTemplateGroupId } = base;
    if (rebuildDatasetId === null) {
      return true;
    }
    const residual = generationOf(rebuildDatasetId, rebuildCanvasId, rebuildTemplateGroupId);
    if ((await pipeline.deletePipeline(residual, signal)).kind !== "ok") {
      return false;
    }
    store.setRebuildGeneration(base.id, null);
    return true;
  }

  /** 第 2 步：建新一代并写回 `rebuild_*`；失败为 `undefined`。 */
  async function buildGeneration(base: KnowledgeBase) {
    const { embedding, embeddingGeneration } = store.settings();
    const template = templateOf(base.template);
    if (embedding === null || template === undefined) {
      return undefined;
    }
    const input = {
      name: resourceName(base.id, embeddingGeneration),
      parserId: template.parserId,
      raptor: base.raptor,
      graph: base.graph,
      embeddingModel: embeddingModelOf(embedding.name),
    };
    const created = await createGeneration({ client, pipeline }, input, signal);
    if (created.kind !== "ok") {
      return undefined;
    }
    store.setRebuildGeneration(base.id, created.value);
    return created.value.datasetId;
  }

  /** 第 3 步的一份：下载 → 上传 → 触发解析。原件不在了是跳过；`null` 是这一库失败。 */
  async function transfer(document: KbDocument, from: string, to: string): Promise<Moved> {
    const downloaded = await client.downloadDocument(from, document.ragflowDocumentId, signal);
    if (downloaded.kind === "not_found") {
      return SKIPPED;
    }
    if (downloaded.kind !== "ok") {
      return null;
    }
    const { name, size } = document;
    const upload = multipartUpload({ name, size, source: downloaded.value.body });
    const uploaded = await client.uploadDocument(to, upload, signal);
    if (uploaded.kind !== "ok") {
      return null;
    }
    const parsed = await client.parseDocument(to, uploaded.value.id, signal);
    return parsed.kind === "ok" ? { ragflowDocumentId: uploaded.value.id } : null;
  }

  /** 第 1–4 步；切换提交了即 `true`。 */
  async function switchToNew(base: KnowledgeBase): Promise<boolean> {
    const next = (await clearResidual(base)) ? await buildGeneration(base) : undefined;
    if (next === undefined) {
      return false;
    }
    const replaced: { id: string; ragflowDocumentId: string }[] = [];
    const skipped: string[] = [];
    for (const document of store.listDocuments(base.id)) {
      const moved = await transfer(document, base.datasetId, next);
      if (moved === null) {
        return false;
      }
      if ("skipped" in moved) {
        skipped.push(document.id);
      } else {
        replaced.push({ id: document.id, ragflowDocumentId: moved.ragflowDocumentId });
      }
    }
    if (signal.aborted) {
      return false;
    }
    store.switchGeneration(base.id, { replaced, skipped }, () => {
      record("知识库重建完成", { id: base.id, result: "ok", skipped });
    });
    return true;
  }

  /** 持锁处理一个库。已中止时第一件事就返回：锁可能在 DB 关闭之后才交到这里。 */
  async function rebuildLocked(id: string): Promise<void> {
    if (signal.aborted) {
      return;
    }
    const base = store.getBase(id);
    if (base === undefined || base.state !== "rebuilding") {
      return;
    }
    if (!(await switchToNew(base))) {
      fail(id);
      return;
    }
    const old: PipelineResources = generationOf(
      base.datasetId,
      base.canvasId,
      base.templateGroupId,
    );
    await pipeline.discard(old, signal);
  }

  /** 本地写入抛错（DB 约束、DB 已不可用）同样算这一库失败；连失败都写不进去时这一库留在 `rebuilding`，下次启动续做。 */
  async function guarded(id: string): Promise<void> {
    try {
      await rebuildLocked(id);
    } catch {
      try {
        fail(id);
      } catch {
        // 写不进 DB：没有可写的地方，也不能让这一轮 reject（续做的失败不影响进程）。
      }
    }
  }

  async function drain(): Promise<void> {
    try {
      do {
        again = false;
        if (signal.aborted) {
          return;
        }
        for (const { id } of store.listBasesInState("rebuilding")) {
          if (signal.aborted) {
            return;
          }
          await locks.rebuild(id, () => {
            current = guarded(id);
            return current;
          });
        }
      } while (again);
    } catch {
      // 清单读不出来（DB 已关闭）：这一轮到此为止，状态留给下次启动。
    } finally {
      draining = false;
    }
  }

  function wake(): void {
    if (signal.aborted) {
      return;
    }
    if (draining) {
      again = true;
      return;
    }
    draining = true;
    schedule(drain);
  }

  return {
    /** 确认重建与重试之后（设置锁内的事务提交之后）调用。 */
    wake,
    /** `server_started` 之后的续做，不等待。 */
    start: wake,
    /** 中止在途请求，只等正在持锁处理的那一个库（见文件头）。 */
    async stop(): Promise<void> {
      controller.abort();
      await current;
    },
  };
}

export type KbRebuilder = Pick<ReturnType<typeof createKbRebuilder>, "start" | "stop">;
